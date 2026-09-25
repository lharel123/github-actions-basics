# Touchline ⚽

משחק מנג'ר כדורגל קליל (בסגנון Football Manager Lite) עם מצב **Be a Pro**, שרץ על שרת Ubuntu שלך ונגיש **רק דרך Tailscale**.

## מה יש במשחק

- **12 ליגות, 228 קבוצות, כ-6,300 שחקנים**: הליגה הראשונה והשנייה באנגליה, ספרד, גרמניה, איטליה, צרפת וישראל.
- **קריירת מנג'ר**: בחירת קבוצה, סגל, מערך (6 מערכים) וגישה, הרכב ידני על המגרש, שוק העברות (חיפוש, הצעות, הצעות נגדיות, מכירה ושחרור), כספים, ציפיות ההנהלה (כולל פיטורים והצעות עבודה), עלייה וירידה, התפתחות שחקנים, פרישות ומחלקת נוער.
- **משחק חי**: שידור בעברית דקה אחר דקה, סטטיסטיקה (החזקה, בעיטות, xG), חילופים ושינוי גישה תוך כדי משחק, וציונים לשחקנים.
- **Be a Pro**: יוצרים שחקן בן 17 ומקבלים החלטות ברגעי המפתח (לבעוט, למסור, לכדרר, לתקל...). לכל אפשרות מוצג סיכוי ההצלחה לפי התכונות שלך מול היריבה. יש אימון שבועי, התפתחות תכונות, הצעות מקבוצות גדולות יותר וזימונים לנבחרת.
- **שמירה אוטומטית בשרת** אחרי כל שבוע, כך שאפשר להמשיך מכל מכשיר שמחובר ל-VPN. יש גם ייצוא וייבוא של קובץ שמירה.
- **סמלי קבוצות אמיתיים** ל-150 קבוצות, וסמל בצבעי הקבוצה לשאר.

## התקנה על Ubuntu

```bash
git clone -b claude/ubuntu-game-upgraded-afazse https://github.com/lharel123/github-actions-basics
cd github-actions-basics/touchline
sudo ./deploy/install.sh
```

הסקריפט מתקין Node.js ו-Tailscale אם הם חסרים. אם Tailscale לא מחובר, הוא מבקש להתחבר. אחר כך הוא:
1. מתקין את המשחק ב-`/opt/touchline` כשירות systemd (`touchline`) שרץ תחת משתמש מערכת מוגבל.
2. מוריד את סמלי הקבוצות לשרת עצמו.
3. מגדיר את השרת להאזין **רק לכתובת ה-Tailscale** של המכונה.
4. אם `ufw` פעיל, מוסיף כלל שמתיר את הפורט רק על `tailscale0`.

בסוף ההתקנה מודפסת הכתובת, למשל `http://100.x.y.z:8080`. היא נפתחת מכל מכשיר שמחובר ל-Tailscale שלך.

אפשרויות:
- `sudo MODE=serve ./deploy/install.sh`: מפעיל HTTPS בתוך ה-tailnet דרך `tailscale serve`, בכתובת `https://<machine>.<tailnet>.ts.net`.
- `sudo PORT=9000 ./deploy/install.sh`: פורט אחר.
- לוגים: `journalctl -u touchline -f`
- הסרה: `sudo ./deploy/uninstall.sh` (השמירות נשארות ב-`/var/lib/touchline`; `PURGE=1` מוחק גם אותן).

### שכבות האבטחה
- השרת מאזין רק על ממשק Tailscale.
- גם אם הוא נחשף בטעות, הוא מנתק כל חיבור שלא מגיע מכתובת Tailscale (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) או מ-localhost. אפשר לשנות את זה ב-`ALLOWED_NETS` בקובץ `/etc/touchline.env`.
- כלל ufw על `tailscale0`.
- כותרות אבטחה (CSP מחמיר) והקשחה של שירות systemd.

## מקורות הנתונים

| מה | מקור |
|---|---|
| שחקנים וקבוצות באנגליה, ספרד, גרמניה, איטליה וצרפת | מאגר EA FC 26 (ספטמבר 2025) דרך [EAFC26-DataHub](https://github.com/ismailoksuz/EAFC26-DataHub) |
| קבוצות ליגת העל והליגה הלאומית 2025/26, שמות בעברית וצבעים | [israeli-league-charts](https://github.com/kadishay/israeli-league-charts) |
| סמלים | [football-logos](https://github.com/luukhopman/football-logos). **לא נשמרים ב-git** כי הם סימנים מסחריים; `deploy/fetch_crests.sh` מוריד אותם לשרת |

**שימו לב:** לא נמצא מקור פתוח עם סגלי הקבוצות הישראליות, ולכן **שחקני הקבוצות הישראליות נוצרו אוטומטית** (שמות ויכולות). הקבוצות עצמן אמיתיות. אפשר להחליף אותם בשחקנים אמיתיים בעריכת `public/data/world.json`: כל שחקן שנוצר מסומן ב-`"gen": 1`.

המשחק מתחיל בעונת 2025/26, בהתאם לנתונים.

### בנייה מחדש של הנתונים
```bash
python3 scripts/build_world.py path/to/players.csv path/to/israeli-league-charts
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/luukhopman/football-logos logos
git -C logos -c core.quotepath=off ls-tree -r --name-only HEAD > logo_files.txt
python3 scripts/build_crests.py logo_files.txt
```

## פיתוח
```bash
node server.js                     # http://127.0.0.1:8080 (מאזין רק מקומית כברירת מחדל)
./deploy/fetch_crests.sh           # סמלים מקומיים (אופציונלי)
npx jest touchline                 # בדיקות (מתיקיית השורש של הריפו)
```

המבנה:
- `public/js/engine.js`: כל הלוגיקה (סימולציית משחק, עונות, העברות, Be a Pro). קוד טהור בלי DOM, שנבדק ב-`engine.test.js`.
- `public/js/app.js`: הממשק.
- `server.js`: שרת בלי תלויות חיצוניות. מגיש את המשחק ומנהל שמירות (`/api/saves`).
