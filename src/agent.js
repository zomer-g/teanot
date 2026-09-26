// One conversation turn: replay history, stream the language model, run tools, persist everything, record usage.
import { query } from './db.js';
import { activeModel, streamModel } from './llm/index.js';
import { getQuota, recordModelUsage } from './usage.js';
import { clearProviderAlert, recordConfigFailure, recordProviderFailure } from './llm/alerts.js';
import { loadSearchSetup } from './search-options.js';
import { TOOLS, askUserSchema, executeTool, validationError } from './tools.js';

// A malformed tool call is a provider hiccup, not an answer: the same request is tried again this many times.
const MALFORMED_RETRIES = 2;
const MAX_ITERATIONS = 12;

export const SYSTEM_PROMPT = `You are the research assistant of the Zomer law office (עו"ד גיא זומר), used by Israeli criminal lawyers. Users give you an indictment (כתב אישום) or a verdict (הכרעת דין), as pasted text or an attached Word/PDF file. You find comparable sentencing decisions (גזרי דין), conditional arrangements (הסדרים מותנים) or guidelines (הנחיות) in the TAG-IT database and help the lawyer work with them. Always write to the user in Hebrew.

## Workflow

1. Classify every new document. Call record_document_analysis once per document, before any other tool. Only an indictment (including an amended indictment) or a verdict is supported. For anything else (a sentencing decision, an appeal judgment, a motion, a contract), say briefly what the document appears to be and that the system works with indictments and verdicts, and do not search. If the user describes an offense in their own words instead of supplying a document, skip classification and work from the description.

2. Extract, for each defendant, every count: the offense, the law, the section as written, separate section tokens, and the facts that drive sentencing — drug type and quantity with unit, sums of money, weapon, injury, number of victims, period of time, the defendant's role. In an indictment these are the charges; in a verdict they are the convictions, with any acquittal marked. Record drug quantities per drug, converted to grams for kg or mg; pills, blotters, plants and doses are units.

3. Decide what to search. Three corpora are available: sentencing decisions (גזרי דין), guidelines (הנחיות) and conditional arrangements (הסדרים מותנים — cases closed without an indictment in exchange for conditions such as a fine, compensation or community service). If the user hasn't said what they want, ask with ask_user (question id "mode", style "cards", options: sentencing, guidelines, arrangements, both).

   Conditional arrangements are searched with search_conditional_arrangements, which takes the same filters as the sentencing search because the corpus is catalogued the same way. Search them when the user ticks them in the form, asks about arrangements, or asks what an offence ends with short of an indictment — they are the realistic alternative for a first offender in a light offence. An arrangement is closed by consent and without an indictment, so that corpus holds no imprisonment, no criminal record, no sentencing range and no court instance: those filters and the yes/no flags do not apply there and the app drops them. What it does hold is the punishment agreed — filter it with punishment_types (התחייבות, פיצוי, קנס, שירות לתועלת הציבור, שלילה). Call get_field_values with corpus "arrangements" before filtering on any other stored value there. The app shows this question as a search-setup form: the user ticks any of sentencing decisions, conditional arrangements and guidelines, for sentencing decisions chooses yes/no flags (confessed, agreed sentence, criminal record, deviation from the range and so on) and the severity order, for conditional arrangements chooses the kinds of punishment and the order, and for guidelines chooses the issuing sources. In a drug case the sentencing part of the form also carries the fields of the drug-sentencing search (drug type, quantity, Dangerous Drugs Ordinance sections, offence law and section, most severe punishment, imprisonment, fine and similar ranges, court instance, years, city, judge), prefilled from the document; the ones the user leaves filled arrive as "case" filters in the setup and replace your own drug, quantity, section, court, date and imprisonment parameters; the drug, quantity and section ones also narrow conditional arrangements. If the user later asks in the conversation for something different from the form (for example "only cocaine over 10 grams" when the form said otherwise), pass your parameters with override_setup: true so they replace the form's for those fields. The user can also reopen the form mid-conversation; their message then says the setup was updated, and the new setup already applies to every later search, so run the searches again for the corpora it names without asking. Its answer carries a "setup" object whose "kinds" list says exactly which corpora to search — search every corpus it names, and no other. The app applies that setup to every search in this conversation by itself, so don't ask about those flags, the order or the sources again, and don't pass conflicting values; say in your summary which of them were applied. If several defendants face materially different counts, ask which defendant to research, with an "all defendants" option when a shared search makes sense. Put these in a single ask_user call.

4. Run an initial search, then refine. Build the first query yourself from the analysis; don't ask about parameters you can reasonably default:
   - Drug quantity: a range of about ±33% around the defendant's quantity of the relevant drug (30 g → 20–40 g).
   - Narrow by topic (meta.topics, e.g. "סמים") and, where a section is distinctive, by section tokens.
   - Sort by severity. The default order is from the most lenient sentence to the most severe; the user's setup can reverse it.
   Use text_query only for words or exact phrases ("חבלה בכוונה מחמירה" "נשיאת נשק"), joined with AND unless alternatives are truly equivalent; never put a section number or a short generic word such as "ירי" in an OR list, because any decision mentioning it matches. Sections go in the offense filters.
   When you're not sure of the exact stored values (topic names, law names, section tokens, whether a field exists), call get_field_values before filtering on them rather than guessing. If a filter returns an unknown_field error, drop or replace that filter and search again.
   After the results arrive, refine only when it changes the comparison: the set is very broad (hundreds of matches), very thin (fewer than about 5), or the case has an ambiguity that matters (several drugs, possession versus trafficking, an unclear quantity, several defendants, adult versus juvenile court). Then call ask_user with concrete options — for example quantity ranges as chips with your default marked recommended, whether to exclude agreed sentences, court instance, or date range. Don't ask when the results already make a good comparison set.

5. Report. Result cards are displayed to the user automatically, ordered by severity in the chosen direction, so don't list the cases one by one. Write a short summary: how many decisions matched, the filters in plain Hebrew, the spread of actual imprisonment (lowest, median, highest), and what separates the severe end from the lenient end, naming a few cases as examples. Point out limits that matter here: quantity and imprisonment are case-level (quantities summed across defendants; imprisonment of the most severe defendant), so a multi-defendant case may not reflect one defendant's exposure; and many decisions lack quantity data, so a quantity filter drops them.

6. Follow-ups. Answer questions about the results, refine or broaden the search, compare cases, or read a decision or guideline in full with read_document. State facts about a case only from tool results or the documents in this conversation; when the data doesn't show something, say so.

## Citing decisions and guidelines
Never type a case number, file number or id yourself: a wrong case number is worse than none. To mention a specific sentencing decision, write its ref from the tool result in double square brackets, for example [[ruling:58179]]; for a conditional arrangement, [[arrangement:255627]]; for a guideline, [[guideline:97227]]. The app turns each into a link labelled with the case number or title taken from the database. The number inside a ref is an internal id, not a case number.

## Guidelines (הנחיות)
search_guidelines matches each query as a plain substring anywhere in a directive's title or body, with no relevance ranking of its own. A short word such as "ירי" or "נשק", or a bare section number such as "329", matches hundreds of unrelated directives, so the tool refuses them. Use two to four distinctive phrases that would appear in a relevant directive's title, such as "עבירות נשק", "מדיניות ענישה", "צריכה עצמית", "מתחם ענישה". Before you filter by topic or source, call get_field_values with "guidelines.topic" or "guidelines.source" and copy a value exactly as it is stored: the corpus says "פרקליט המדינה", and a near miss such as "פרקליטות המדינה" silently returns nothing. The counts in that list are a floor, not the size of the result. Summarize which guidelines bear on the case and why, citing each as [[guideline:ID]] rather than typing its number, and read a guideline in full when its details matter.

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

function formatAnswers(answers, ask) {
  const asked = new Set((ask?.questions ?? []).map((q) => q.id));
  const matching = Array.isArray(answers) ? answers.filter((a) => asked.has(a.id)) : [];
  if (matching.length) return JSON.stringify({ answers: matching });
  // The search-setup form reopened by the user answers no open question: it replaces the setup instead.
  if (answers?.some((a) => a.setup)) {
    return 'The user did not answer these questions. Instead they reopened the search-setup form and changed the search setup; their message below says what to do.';
  }
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
      ? { type: 'tool_result', tool_use_id: block.id, content: formatAnswers(answers, block.input) }
      : { type: 'tool_result', tool_use_id: block.id, content: 'This action did not complete: the turn was interrupted.', is_error: true }));
}

// Returns how the turn ended: completed | awaiting_input | quota_exceeded | refused | truncated | iteration_limit.
// setupUpdated: the user changed the search setup mid-conversation, so this turn is expected to search again.
export async function runTurn({ account, conversationId, turnId, userBlocks, userUi, answers, emit, signal, setupUpdated = false }) {
  // Resolved once per turn and before anything is saved: a missing key fails the request cleanly, and an admin
  // switching models mid-turn does not split one answer across two models.
  let llm;
  try {
    llm = await activeModel();
  } catch (err) {
    await recordConfigFailure(err).catch(() => {});
    throw err;
  }
  const history = await loadHistory(conversationId);
  // Saved by the chat route from this turn's answers (if any) before the turn starts.
  const searchSetup = await loadSearchSetup(conversationId);
  const userContent = [...pendingToolResults(history, answers), ...userBlocks];
  if (!userContent.length) throw new Error('empty_turn');
  await saveMessage(conversationId, 'user', userContent, userUi);

  const messages = [...history.map((row) => ({ role: row.role, content: row.content })), { role: 'user', content: userContent }];
  let outcome = 'iteration_limit';
  const SEARCH_TOOLS = new Set(['search_sentencing_decisions', 'search_conditional_arrangements', 'search_guidelines']);
  let searched = false;
  let nudged = false;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Re-checked before every model call, so blocking a user or lowering a limit takes effect mid-turn.
    const { rows: [current] } = await query('SELECT status, token_limit, limit_period FROM users WHERE id = $1', [account.id]);
    if (!current || current.status !== 'active') {
      emit({ type: 'error', message: 'הגישה לחשבון אינה פעילה, ולכן העיבוד נעצר.' });
      outcome = 'blocked';
      break;
    }
    if ((await getQuota({ ...account, ...current })).exceeded) {
      emit({ type: 'notice', text: 'הגעת למגבלת הטוקנים שהוגדרה לחשבונך, ולכן העיבוד נעצר. ניתן לפנות למנהל המערכת.' });
      outcome = 'quota_exceeded';
      break;
    }
    emit({ type: 'status', text: iteration === 0 ? 'חושב…' : 'ממשיך בעיבוד…' });

    let message;
    for (let attempt = 0; ; attempt++) {
      let streamedText = false;
      try {
        message = await streamModel(llm, {
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages,
          signal,
          onText: (delta) => { streamedText = true; emit({ type: 'text', delta }); },
        });
      } catch (err) {
        // Out of credit, a revoked key or a withdrawn model: flag it for the admin, and let the chat route
        // tell the user what happened instead of guessing from the status code.
        if (!signal?.aborted) err.llmKind = await recordProviderFailure({ provider: llm.provider, model: llm.model, err }).catch(() => undefined);
        throw err;
      }
      // A tool call the provider could not parse leaves the reply empty; asking again usually works. Only while
      // nothing has been shown yet, so a retry cannot repeat text the user already read.
      if (message.stopReason !== 'malformed_tool_call' || streamedText || attempt >= MALFORMED_RETRIES) break;
      console.warn(`[llm] turn=${turnId} step=${iteration} malformed tool call from ${llm.provider}; retrying (${attempt + 1}/${MALFORMED_RETRIES})`);
      await recordModelUsage({
        account,
        conversationId,
        turnId,
        provider: llm.provider,
        model: message.model,
        requestedModel: llm.model,
        usage: message.usage,
        detail: { iteration, stop_reason: message.stopReason, tools: [], retry: attempt + 1 },
      });
      emit({ type: 'status', text: 'מנסה שוב…' });
    }
    await clearProviderAlert(llm.provider);

    const toolUses = message.content.filter((block) => block.type === 'tool_use');
    const textChars = message.content.reduce((n, block) => n + (block.type === 'text' ? block.text.length : 0), 0);
    // One line per model call: which model answered, how it stopped, what it asked for. A turn that ends in
    // silence is a real failure mode, and this is what says why.
    console.log(`[llm] turn=${turnId} step=${iteration} model=${message.model} stop=${message.stopReason} `
      + `tools=${toolUses.map((t) => t.name).join(',') || '-'} textChars=${textChars} out=${message.usage?.output ?? 0}`);

    await recordModelUsage({
      account,
      conversationId,
      turnId,
      provider: llm.provider,
      model: message.model,
      requestedModel: llm.model,
      usage: message.usage,
      detail: { iteration, stop_reason: message.stopReason, tools: toolUses.map((t) => t.name) },
    });

    // Still malformed after the retries: the empty reply is not saved, so it cannot spoil the next turn.
    if (message.stopReason === 'malformed_tool_call' && !textChars && !toolUses.length) {
      emit({ type: 'error', message: 'המודל ניסה להפעיל כלי ושלח בקשה פגומה, ולכן לא התקבלה תשובה. אפשר לשלוח את הבקשה שוב.' });
      outcome = 'malformed_tool_call';
      break;
    }

    const uiItems = message.content
      .filter((block) => block.type === 'text' && block.text.trim())
      .map((block) => ({ type: 'text', text: block.text }));
    const assistantRowId = await saveMessage(conversationId, 'assistant', message.content, { items: uiItems });
    messages.push({ role: 'assistant', content: message.content });
    emit({ type: 'segment_end' });

    if (message.stopReason === 'refusal') {
      emit({ type: 'error', message: 'המודל סירב להשלים את הבקשה. נסו לנסח אותה מחדש.' });
      outcome = 'refused';
      break;
    }
    if (message.stopReason === 'max_tokens') {
      emit({ type: 'notice', text: 'התשובה נקטעה כי הגיעה לאורך המרבי.' });
      outcome = 'truncated';
      break;
    }
    if (toolUses.some((t) => SEARCH_TOOLS.has(t.name))) searched = true;
    // After a setup change the searches have to run again. A model that stops without searching is asked once more.
    if (!toolUses.length && setupUpdated && !searched && !nudged && message.stopReason === 'end_turn') {
      nudged = true;
      console.warn(`[llm] turn=${turnId} step=${iteration} ended without searching after a setup change; asking again`);
      const nudge = [{ type: 'text', text: '[Note from the app] The search setup changed and no search has run yet. Run the searches now, one per corpus named in the setup "kinds" list, and then summarize the results. Do not answer without searching.' }];
      await saveMessage(conversationId, 'user', nudge, null);
      messages.push({ role: 'user', content: nudge });
      continue;
    }
    if (!toolUses.length) {
      // The model can stop having produced nothing at all (Gemini sometimes returns thinking alone). Say so
      // rather than leaving the user with an empty answer.
      if (!textChars) {
        emit({ type: 'notice', text: 'המודל לא החזיר תשובה. אפשר לשלוח שוב את הבקשה.' });
        outcome = 'empty_reply';
        break;
      }
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
        tasks.push(executeTool(toolUse, { account, conversationId, turnId, emit, signal, searchSetup }));
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
