# מחקר ענישה · זומר

ממשק צ'ט (בעיצוב האתר z-g.co.il) שמקבל כתב אישום או הכרעת דין — כטקסט או כקובץ Word/PDF — ומאתר גזרי דין או הנחיות רלוונטיים ממאגר TAG-IT, עם שאלות המשך ושאלות מיקוד.

## איך זה עובד

1. **קליטה** – טקסט מודבק, `docx` (mammoth) או `pdf` (pdf-parse). PDF סרוק או PDF שהעברית בו הפוכה נשלח ל-Claude כ-PDF מקורי.
2. **סיווג וניתוח** – Claude (`claude-opus-5`) מסווג את המסמך (כתב אישום / הכרעת דין / אחר) וממלא את הכלי `record_document_analysis`: נאשמים, סעיפים, חוק, ונתונים מהותיים (סוג סם וכמות וכו'). מסמך שאינו נתמך נעצר כאן.
3. **בחירה ומיקוד** – הכלי `ask_user` מציג כרטיסים/צ'יפים (גזרי דין או הנחיות, נאשם, טווח כמות) ומסיים את התור; התשובה חוזרת כ-`tool_result`.
4. **שאילתא ל-TAG-IT** – `search_sentencing_decisions` בונה פילטר על שדות `meta.*` המאונדקסים (למשל `meta.drug_total_g_cocaine` בין 20 ל-40) וממיין לפי `-meta.severity_score`. `search_guidelines` מחפש ב-`/api/public/over-guidelines`. התוצאות מוצגות ככרטיסים מהחמור לקל; "הצגת תוצאות נוספות" טוענת עמודים נוספים בלי טוקנים.
5. **שאלות המשך** – השיחה נשמרת במלואה (כולל המסמך) ונשלחת מחדש עם prompt caching.

## מבנה

```
server.js              Express, מיגרציות בעלייה, static
src/auth.js            SSO של xhostd (JWT בעוגייה __Host-xhost_id), אישור משתמשים, מנהלים
src/agent.js           לולאת Claude: סטרימינג, כלים, שמירה, רישום שימוש, fallbacks
src/tools.js           הגדרות כלים (zod → JSON Schema) והרצתם
src/tagit.js           לקוח TAG-IT (rulings scope 1 + over-guidelines, proxy לקבצים)
src/extract.js         חילוץ טקסט מ-Word/PDF
src/usage.js           יומן שימוש, עלות משוערת, מגבלות טוקנים
src/routes/chat.js     /api/me, /api/chat (SSE), שיחות, "עוד תוצאות", קבצים
src/routes/admin.js    /api/admin: משתמשים, הרשאות, מגבלות, יומן, תמליל שיחה
public/                index.html + app.js (צ'ט), admin.html + admin.js (ניהול)
```

## הרשאות ושימוש

- כל מי שמתחבר ב-SSO נרשם כ"ממתין לאישור". המנהל מאשר/חוסם ב-`/admin`, או מוסיף מראש לפי אימייל.
- `ADMIN_EMAILS` תמיד מנהלים (גם אם מסד הנתונים אבד).
- כל קריאה ל-Claude נרשמת ב-`usage_events` (קלט, פלט, מטמון, עלות משוערת, כלים), וכל פעולת TAG-IT נרשמת גם היא.
- מגבלת טוקנים: ברירת מחדל גלובלית (חודשית או מצטברת) + מגבלה אישית למשתמש. טוקנים = קלט + פלט + כתיבה וקריאה מהמטמון. המגבלה נבדקת לפני כל תור ובין סבבי כלים.
- מחיקת שיחה על ידי משתמש היא מחיקה רכה — היומן נשמר.
- **יומן שאילתות** (`turns`, לשונית "שאילתות" באדמין): שורה לכל בקשה — מי, מה ביקש (טקסט / קובץ / תשובות), אילו חיפושים רצו ב-TAG-IT ועם כמה תוצאות, קריאות Claude, טוקנים, עלות משוערת, משך וסטטוס. סינון לפי משתמש/סטטוס/טקסט/תאריכים וייצוא CSV. כל רשומת `usage_events` מקושרת לבקשה דרך `turn_id`.

## נגישות, פרטיות ובאנר אזהרה

- יעד: WCAG 2.2 רמה AA / ת"י 5568. דילוג לתוכן, אזורי ניווט וכותרות, הכרזות לקוראי מסך (`#liveStatus` / `#liveAlert`) על אבני דרך בלבד, מקלדת מלאה (סרגל צד נייד `inert` כשסגור, לשוניות אדמין עם חיצים, דיאלוג עם מלכודת מיקוד ו-Escape), ניגודיות, `prefers-reduced-motion`, זרימה מחדש ב-320px.
- נבדק ב-axe-core (תגיות wcag2a/aa, wcag21a/aa, wcag22aa ו-best-practice) על כל המסכים — 0 הפרות. בפיתוח מקומי זמין `/vendor/axe.js` (לא בפרודקשן).
- `/accessibility` — הצהרת נגישות, `/privacy` — מדיניות פרטיות (פסקה אחת כל אחת, `public/*.html`). קישורים אליהן בתחתית כל מסך.
- הגופן Heebo מוגש מקומית (`@fontsource-variable/heebo`) — אין פנייה ל-Google Fonts.
- באנר אדמדם זמני (`.sensitive-banner` ב-`index.html` ו-`admin.html`): המערכת אינה מיועדת לחומר אישי ורגיש. להסרה — למחוק את אלמנט ה-`aside`.

## עמידות לניתוקים

- בקשה ממשיכה לרוץ בשרת גם אם הדפדפן התנתק (רשת, סגירת לשונית). הממשק מזהה את הניתוק וממתין לתוצאה השמורה; רק כפתור העצירה (`POST /api/conversations/:id/stop`) עוצר עיבוד.
- בפריסה: SIGTERM נותן לבקשות פעילות עד 8 שניות ומסמן את השאר "נקטע"; גם בעלייה מסומנות בקשות שנשארו "בעיבוד". בממשק מופיע כפתור "המשך".
- יומן השרת כותב `[turn] start` / `[turn] end` — לפני פריסה אפשר לבדוק שאין בקשה פתוחה.

## משתני סביבה

ראו `.env.example`. חובה בפרודקשן: `ANTHROPIC_API_KEY`, `TAGIT_API_KEY`, `ADMIN_EMAILS`, `XHOST_AUTH_AUDIENCES`. `DATABASE_URL` מוזרק על ידי xhostd.

## פיתוח מקומי

```bash
npm install
cp .env.example .env   # למלא מפתחות; DEV_AUTH_EMAIL מדמה משתמש מחובר
npm run dev            # http://localhost:3000 , מסד PGlite מקומי ב-.pglite
```

## פריסה ל-xhostd

```text
create_app(name="teanot", template="app")
git push git@git.xhostd.com:zomerg/teanot.git HEAD:master
set_env ANTHROPIC_API_KEY / TAGIT_API_KEY (secret=True), ADMIN_EMAILS, XHOST_AUTH_AUDIENCES, NODE_ENV=production
deploy(app_name="teanot", channel="prod", ref="master")
```

`install.sh` מתקין תלויות בלבד (אין DB בזמן build); `launch.sh` מריץ את `server.js`, שמריץ מיגרציות ואז מאזין ל-`XHOST_HTTP_PORT`.
