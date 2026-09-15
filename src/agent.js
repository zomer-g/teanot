// One conversation turn: replay history, stream Claude, run tools, persist everything, record usage.
import Anthropic from '@anthropic-ai/sdk';
import { query } from './db.js';
import { getQuota, recordClaudeUsage } from './usage.js';
import { TOOLS, askUserSchema, executeTool, validationError } from './tools.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';
const EFFORT = process.env.CLAUDE_EFFORT || 'high';
const USE_FALLBACKS = process.env.CLAUDE_FALLBACKS !== 'off';
const MAX_ITERATIONS = 12;

let client = null;
const anthropic = () => (client ??= new Anthropic());

export const SYSTEM_PROMPT = `You are the research assistant of the Zomer law office (עו"ד גיא זומר), used by Israeli criminal lawyers. Users give you an indictment (כתב אישום) or a verdict (הכרעת דין), as pasted text or an attached Word/PDF file. You find comparable sentencing decisions (גזרי דין) or guidelines (הנחיות) in the TAG-IT database and help the lawyer work with them. Always write to the user in Hebrew.

## Workflow

1. Classify every new document. Call record_document_analysis once per document, before any other tool. Only an indictment (including an amended indictment) or a verdict is supported. For anything else (a sentencing decision, an appeal judgment, a motion, a contract), say briefly what the document appears to be and that the system works with indictments and verdicts, and do not search. If the user describes an offense in their own words instead of supplying a document, skip classification and work from the description.

2. Extract, for each defendant, every count: the offense, the law, the section as written, separate section tokens, and the facts that drive sentencing — drug type and quantity with unit, sums of money, weapon, injury, number of victims, period of time, the defendant's role. In an indictment these are the charges; in a verdict they are the convictions, with any acquittal marked. Record drug quantities per drug, converted to grams for kg or mg; pills, blotters, plants and doses are units.

3. Decide what to search. If the user hasn't said whether they want sentencing decisions or guidelines, ask with ask_user (question id "mode", style "cards", options: sentencing, guidelines, both). If several defendants face materially different counts, ask which defendant to research, with an "all defendants" option when a shared search makes sense. Put these in a single ask_user call.

4. Run an initial search, then refine. Build the first query yourself from the analysis; don't ask about parameters you can reasonably default:
   - Drug quantity: a range of about ±33% around the defendant's quantity of the relevant drug (30 g → 20–40 g).
   - Narrow by topic (meta.topics, e.g. "סמים") and, where a section is distinctive, by section tokens.
   - Sort by severity.
   When you're not sure of the exact stored values (topic names, law names, section tokens, whether a field exists), call get_field_values before filtering on them rather than guessing. If a filter returns an unknown_field error, drop or replace that filter and search again.
   After the results arrive, refine only when it changes the comparison: the set is very broad (hundreds of matches), very thin (fewer than about 5), or the case has an ambiguity that matters (several drugs, possession versus trafficking, an unclear quantity, several defendants, adult versus juvenile court). Then call ask_user with concrete options — for example quantity ranges as chips with your default marked recommended, whether to exclude agreed sentences, court instance, or date range. Don't ask when the results already make a good comparison set.

5. Report. Result cards are displayed to the user automatically, ordered from most to least severe, so don't list the cases one by one. Write a short summary: how many decisions matched, the filters in plain Hebrew, the spread of actual imprisonment (lowest, median, highest), and what separates the severe end from the lenient end, naming a few cases as examples. Point out limits that matter here: quantity and imprisonment are case-level (quantities summed across defendants; imprisonment of the most severe defendant), so a multi-defendant case may not reflect one defendant's exposure; and many decisions lack quantity data, so a quantity filter drops them.

6. Follow-ups. Answer questions about the results, refine or broaden the search, compare cases, or read a decision or guideline in full with read_document. State facts about a case only from tool results or the documents in this conversation; when the data doesn't show something, say so.

## Guidelines (הנחיות)
search_guidelines matches short Hebrew substrings in the title and body of prosecution and Attorney General directives. Use two to four short, distinctive queries (for example "סמים", "צריכה עצמית", "מתחם ענישה"). Summarize which guidelines bear on the case and why, with directive numbers, and read a guideline in full when its details matter.

## Style
Concise, professional Hebrew written for lawyers. Light Markdown: short headings, bullet lists, bold for key numbers. When you give a sentencing assessment, one short line noting that it's a research aid is enough.`;

async function loadHistory(conversationId) {
  const { rows } = await query(
    'SELECT id, role, content FROM messages WHERE conversation_id = $1 ORDER BY id',
    [conversationId],
  );
  return rows;
}

async function saveMessage(conversationId, role, content, ui) {
  const { rows } = await query(
    'INSERT INTO messages (conversation_id, role, content, ui) VALUES ($1, $2, $3::jsonb, $4::jsonb) RETURNING id',
    [conversationId, role, JSON.stringify(content), ui == null ? null : JSON.stringify(ui)],
  );
  return rows[0].id;
}

function formatAnswers(answers) {
  if (Array.isArray(answers) && answers.length) return JSON.stringify({ answers });
  return 'The user did not pick from the options and wrote a free message instead (below).';
}

// Every tool_use in the last assistant message needs a tool_result before new user content:
// the answers for ask_user, and a cancellation for anything an interrupted turn never finished.
function pendingToolResults(history, answers) {
  const lastIndex = history.findLastIndex((row) => row.role === 'assistant');
  if (lastIndex === -1) return [];
  const answered = new Set(
    history.slice(lastIndex + 1)
      .flatMap((row) => row.content)
      .filter((block) => block.type === 'tool_result')
      .map((block) => block.tool_use_id),
  );
  return history[lastIndex].content
    .filter((block) => block.type === 'tool_use' && !answered.has(block.id))
    .map((block) => (block.name === 'ask_user'
      ? { type: 'tool_result', tool_use_id: block.id, content: formatAnswers(answers) }
      : { type: 'tool_result', tool_use_id: block.id, content: 'This action did not complete: the turn was interrupted.', is_error: true }));
}

// Returns how the turn ended: completed | awaiting_input | quota_exceeded | refused | truncated | iteration_limit.
export async function runTurn({ account, conversationId, turnId, userBlocks, userUi, answers, emit, signal }) {
  const history = await loadHistory(conversationId);
  const userContent = [...pendingToolResults(history, answers), ...userBlocks];
  if (!userContent.length) throw new Error('empty_turn');
  await saveMessage(conversationId, 'user', userContent, userUi);

  const messages = [...history.map((row) => ({ role: row.role, content: row.content })), { role: 'user', content: userContent }];
  let outcome = 'iteration_limit';

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (iteration > 0 && (await getQuota(account)).exceeded) {
      emit({ type: 'notice', text: 'הגעת למגבלת הטוקנים שהוגדרה לחשבונך, ולכן העיבוד נעצר. ניתן לפנות למנהל המערכת.' });
      outcome = 'quota_exceeded';
      break;
    }
    emit({ type: 'status', text: iteration === 0 ? 'חושב…' : 'ממשיך בעיבוד…' });

    const stream = anthropic().beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
      output_config: { effort: EFFORT },
      cache_control: { type: 'ephemeral' },
      ...(USE_FALLBACKS ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    }, { signal });
    stream.on('text', (delta) => emit({ type: 'text', delta }));
    const message = await stream.finalMessage();

    const toolUses = message.content.filter((block) => block.type === 'tool_use');
    await recordClaudeUsage({
      account,
      conversationId,
      turnId,
      model: message.model,
      usage: message.usage,
      detail: { iteration, stop_reason: message.stop_reason, tools: toolUses.map((t) => t.name) },
    });

    const uiItems = message.content
      .filter((block) => block.type === 'text' && block.text.trim())
      .map((block) => ({ type: 'text', text: block.text }));
    const assistantRowId = await saveMessage(conversationId, 'assistant', message.content, { items: uiItems });
    messages.push({ role: 'assistant', content: message.content });
    emit({ type: 'segment_end' });

    if (message.stop_reason === 'refusal') {
      emit({ type: 'error', message: 'המודל סירב להשלים את הבקשה. נסו לנסח אותה מחדש.' });
      outcome = 'refused';
      break;
    }
    if (message.stop_reason === 'max_tokens') {
      emit({ type: 'notice', text: 'התשובה נקטעה כי הגיעה לאורך המרבי.' });
      outcome = 'truncated';
      break;
    }
    if (!toolUses.length) {
      outcome = 'completed';
      break;
    }

    const asks = [];
    const tasks = [];
    for (const toolUse of toolUses) {
      if (toolUse.name === 'ask_user') {
        const parsed = askUserSchema.safeParse(toolUse.input);
        if (parsed.success) asks.push({ toolUse, data: parsed.data });
        else tasks.push(Promise.resolve(validationError(toolUse, parsed.error.issues)));
      } else {
        tasks.push(executeTool(toolUse, { account, conversationId, turnId, emit, signal }));
      }
    }
    const results = await Promise.all(tasks);
    for (const result of results) if (result.ui) uiItems.push(result.ui);
    for (const ask of asks) {
      const item = { type: 'questions', toolUseId: ask.toolUse.id, data: ask.data };
      uiItems.push(item);
      emit({ type: 'questions', toolUseId: ask.toolUse.id, data: ask.data });
    }
    await query('UPDATE messages SET ui = $2::jsonb WHERE id = $1', [assistantRowId, JSON.stringify({ items: uiItems })]);

    if (results.length) {
      const content = results.map((result) => result.block);
      await saveMessage(conversationId, 'user', content, null);
      messages.push({ role: 'user', content });
    }
    if (asks.length) { // wait for the user's answers
      outcome = 'awaiting_input';
      break;
    }
  }

  await query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
  return outcome;
}
