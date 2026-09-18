// Wording for the language-model alerts an admin sees in the chat and in the admin panel (src/llm/alerts.js).
export const PROVIDER_LABELS = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', gemini: 'Google Gemini' };

export const BILLING_URLS = {
  anthropic: 'https://console.anthropic.com/settings/billing',
  openai: 'https://platform.openai.com/settings/organization/billing/overview',
  gemini: 'https://console.cloud.google.com/billing',
};

const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (v) => new Date(v).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
const day = (v) => new Date(`${v}T00:00:00`).toLocaleDateString('he-IL', { dateStyle: 'short' });

// → { level: 'error' | 'warning', title, body, detail, billingUrl }
export function describeAlert(alert) {
  const label = PROVIDER_LABELS[alert.provider] ?? alert.provider;
  const billingUrl = BILLING_URLS[alert.provider] ?? null;
  if (alert.type === 'low_budget') {
    const remaining = Math.max(0, alert.remainingUsd);
    return {
      level: 'warning',
      title: `הקרדיט אצל ${label} עומד להיגמר`,
      body: `לפי החישוב נשארו כ-${usd(remaining)} מתוך ${usd(alert.amountUsd)} שנטענו ב-${day(alert.since)} (סף ההתראה: ${usd(alert.warnBelowUsd)}). `
        + 'כדאי לטעון קרדיט אצל הספק ולעדכן את הסכום בלשונית "מודל שפה" בניהול.',
      detail: alert.unpricedCalls ? `${alert.unpricedCalls} קריאות נרשמו ללא מחיר ואינן נכללות בחישוב, כך שהיתרה בפועל נמוכה יותר.` : null,
      billingUrl,
    };
  }
  const since = alert.count > 1 ? ` מאז ${when(alert.firstAt)} (${alert.count} פעמים, לאחרונה ב-${when(alert.lastAt)})` : ` ב-${when(alert.lastAt)}`;
  const inactive = alert.active === false ? ' הספק הזה אינו הפעיל כרגע.' : ' כל עוד זה נמשך, המערכת אינה עונה למשתמשים.';
  const titles = {
    billing: `נראה שהקרדיט אצל ${label} נגמר`,
    auth: `${label} דוחה את מפתח ה-API`,
    model: `המודל ${alert.model} אינו זמין אצל ${label}`,
    config: `לא הוגדר מודל פעיל או מפתח API עבור ${label}`,
  };
  const actions = {
    billing: 'יש לטעון קרדיט בחשבון אצל הספק (או לבדוק את מכסת החשבון).',
    auth: 'יש לבדוק את המפתח ולהזין מפתח תקין בלשונית "מודל שפה" בניהול.',
    model: 'יש לבחור מודל אחר בלשונית "מודל שפה" בניהול.',
    config: 'יש להגדיר מפתח ומודל בלשונית "מודל שפה" בניהול.',
  };
  return {
    level: 'error',
    title: titles[alert.kind] ?? `שגיאה מ-${label}`,
    body: `${alert.kind === 'config' ? 'שאילתות נכשלו' : 'הספק דחה את הקריאות'}${since}.${inactive} ${actions[alert.kind] ?? ''} ההתראה תיעלם מעצמה אחרי הקריאה המוצלחת הבאה.`,
    detail: alert.message ? `הודעת הספק: ${alert.message}` : null,
    billingUrl: alert.kind === 'billing' ? billingUrl : null,
  };
}
