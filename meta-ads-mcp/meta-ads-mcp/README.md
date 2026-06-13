# Meta Ads MCP Server

سيرفر MCP حقيقي يربط Meta Ads API بـ Claude

## الأدوات المتاحة

| الأداة | الوصف |
|--------|-------|
| `get_campaigns_performance` | أداء الحملات (ROAS، إنفاق، CTR) |
| `get_ads_performance` | أداء الإعلانات الفردية |
| `get_adsets_performance` | الرابحة والخاسرة من مجموعات الإعلانات |
| `pause_ad_set` | إيقاف مجموعة إعلانية |
| `scale_adset_budget` | تضخيم أو تخفيض الميزانية |
| `morning_check` | التقرير الصباحي الشامل |
| `get_account_info` | معلومات الحساب والرصيد |

## النشر على Render

### الخطوة 1 — رفع الملفات على GitHub
1. أنشئ مستودع جديد على github.com
2. ارفع الملفات الثلاثة: `server.py`, `requirements.txt`, `render.yaml`

### الخطوة 2 — النشر على Render
1. اذهب إلى render.com وسجّل دخول
2. انقر **New → Web Service**
3. اربط مستودع GitHub
4. في **Environment Variables** أضف:
   - `META_ACCESS_TOKEN` = توكنك
   - `META_AD_ACCOUNT_ID` = `667473139514102` (بدون act_)
5. انقر **Deploy**

### الخطوة 3 — الربط مع Claude
بعد النشر ستحصل على رابط مثل:
`https://meta-ads-mcp.onrender.com`

اذهب إلى claude.ai → Settings → Connectors → Add custom connector:
- **Name:** Meta Ads MCP
- **Server URL:** `https://meta-ads-mcp.onrender.com/sse`
- **Auth type:** None (الأمان عبر التوكن في البيئة)

## الاستخدام في Claude

```
افحص أداء حملاتي الإعلانية آخر 7 أيام
```

```
أعطني التقرير الصباحي وأوقف الإعلانات الخاسرة
```

```
ضخّم ميزانية المجموعة الرابحة 20%
```
