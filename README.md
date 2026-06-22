<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=6,11,20&height=200&section=header&text=ShopDashboard&fontSize=60&fontColor=fff&animation=twinkling&fontAlignY=35&desc=لوحة%20محاسبة%20الأعمال%20المتكاملة%20مع%20سلة&descAlignY=60&descSize=18" width="100%"/>

<br/>

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Salla](https://img.shields.io/badge/Salla-Partner%20API-7B2FBE?style=for-the-badge)](https://salla.dev/)
[![Meta Ads](https://img.shields.io/badge/Meta%20Ads-API-1877F2?style=for-the-badge&logo=meta&logoColor=white)](https://developers.facebook.com/)
[![TikTok Ads](https://img.shields.io/badge/TikTok%20Ads-API-010101?style=for-the-badge&logo=tiktok&logoColor=white)](https://ads.tiktok.com/)

<br/>

![Status](https://img.shields.io/badge/🚀%20Status-Production%20Ready-brightgreen?style=flat-square)
![Version](https://img.shields.io/badge/📦%20Version-1.0.0-blue?style=flat-square)
![License](https://img.shields.io/badge/📄%20License-MIT-green?style=flat-square)
![Commits](https://img.shields.io/badge/⚡%20Commits-158%2B-orange?style=flat-square)
![Lang](https://img.shields.io/badge/🌐%20Language-Arabic%20RTL-red?style=flat-square)

</div>

---

<div align="center">

## 💡 ما هو ShopDashboard؟

</div>

> **ShopDashboard** هو تطبيق ويب متكامل **(Full-Stack Web App)** مبني بـ Node.js وExpress وSQLite، يربط متجرك على منصة **سلة** بشكل حقيقي وتلقائي عبر **OAuth 2.0**، مع إدارة محاسبية شاملة للمصروفات، الأرباح، والأرشفة الشهرية — كل ذلك في لوحة تحكم واحدة أنيقة.

<br/>

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║   🛒 سلة API  ━━━━━━━━━━━━━━━━━━━━┐                                        ║
║   📘 Meta Ads ━━━━━━━━━━━━━━━━━━━━┤                                        ║
║   🎵 TikTok Ads ━━━━━━━━━━━━━━━━━━┼━━━► ⚙️ ShopDashboard Engine          ║
║   💬 WhatsApp Bot ━━━━━━━━━━━━━━━━┤      (Node.js + Express + SQLite)      ║
║   ☁️ Google Drive ━━━━━━━━━━━━━━━━┘                                        ║
║                                          │                                   ║
║                                          ▼                                   ║
║                                   📊 لوحة التحكم                           ║
║                                (Dashboard + Reports)                         ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

---

## ✨ المميزات الرئيسية

<table>
<tr>
<td width="50%">

### 🛒 ربط سلة الذكي
- ✅ تكامل **OAuth 2.0** رسمي مع سلة
- ✅ جلب الطلبات والمنتجات والعملاء تلقائياً
- ✅ استيراد بيانات Excel من سلة
- ✅ تحديث تلقائي بدون انقطاع

</td>
<td width="50%">

### 📊 لوحة المحاسبة
- ✅ تتبع الإيرادات والمصروفات
- ✅ حساب الأرباح الصافية
- ✅ أرشفة شهرية تلقائية
- ✅ تقارير Excel قابلة للتصدير

</td>
</tr>
<tr>
<td width="50%">

### 📢 إدارة الإعلانات
- ✅ **Meta Ads** (Facebook + Instagram)
- ✅ **TikTok Ads** API
- ✅ تحليل ROAS, POAS, CAC, AOV
- ✅ تتبع حملات التسويق

</td>
<td width="50%">

### 🤖 أتمتة متقدمة
- ✅ **WhatsApp Bot** لإشعارات الطلبات
- ✅ **Google Drive** لحفظ الملفات
- ✅ **MCP Server** لتكامل Claude AI
- ✅ **Nginx** جاهز للإنتاج

</td>
</tr>
</table>

---

## 🛠️ التقنيات المستخدمة

<div align="center">

| الطبقة | التقنية | الوصف |
|--------|---------|-------|
| ![Backend](https://img.shields.io/badge/-Backend-FF6B6B?style=flat-square) | **Node.js 18+ / Express 4** | خادم الـ API الرئيسي |
| ![Database](https://img.shields.io/badge/-Database-4ECDC4?style=flat-square) | **SQLite 3** | قاعدة بيانات مدمجة خفيفة |
| ![Auth](https://img.shields.io/badge/-Auth-45B7D1?style=flat-square) | **OAuth 2.0 (Salla)** | مصادقة آمنة مع سلة |
| ![Security](https://img.shields.io/badge/-Security-96CEB4?style=flat-square) | **Helmet + Rate Limiter** | حماية API متقدمة |
| ![Integrations](https://img.shields.io/badge/-Integrations-FFEAA7?style=flat-square) | **Meta + TikTok + WhatsApp** | تكاملات إعلانية وتواصل |
| ![Storage](https://img.shields.io/badge/-Storage-DDA0DD?style=flat-square) | **Google Drive API** | تخزين سحابي للملفات |
| ![Export](https://img.shields.io/badge/-Export-98FB98?style=flat-square) | **XLSX** | تصدير تقارير Excel |
| ![Deploy](https://img.shields.io/badge/-Deploy-F0E68C?style=flat-square) | **Nginx / VPS** | نشر على السيرفر |

</div>

---

## 📁 هيكل المشروع

```
📦 shopdashboard/
│
├── 📄 server.js              ← الخادم الرئيسي (Entry Point)
├── 📄 database.js            ← إدارة قاعدة البيانات SQLite
├── 📄 package.json           ← التبعيات والسكريبتات
├── 📄 .env.example           ← نموذج المتغيرات البيئية
│
├── 📁 src/                   ← المنطق البرمجي الأساسي
│   ├── middlewares/
│   │   └── auth.js           ← المصادقة والحماية
│   └── routes/               ← مسارات الـ API
│
├── 📁 public/                ← الواجهة الأمامية (Frontend)
│   ├── 📄 index.html         ← لوحة التحكم الرئيسية
│   ├── 📄 login.html         ← صفحة تسجيل الدخول
│   ├── 📁 css/
│   │   └── style.css         ← التنسيق الموحد
│   └── 📁 js/
│       └── app.js            ← منطق الواجهة
│
├── 📁 meta-ads-mcp/          ← MCP Server لـ Meta Ads + Claude AI
├── 📁 sho9_whatsapp_bot/     ← بوت واتساب للطلبات
├── 📁 tests/                 ← اختبارات الـ API
│
└── 📄 import_excel_to_db.js  ← استيراد بيانات Excel لقاعدة البيانات
```

---

## 🚀 البدء السريع

### 1️⃣ استنساخ المشروع وتثبيت التبعيات

```bash
git clone https://github.com/Eissaali11/shopdashboard.git
cd shopdashboard
npm install
```

### 2️⃣ إعداد المتغيرات البيئية

```bash
cp .env.example .env
```

ثم عدّل ملف `.env`:

```env
# ── الإعدادات الأساسية ──────────────────────────────
PORT=3000
SESSION_SECRET=your_super_secret_key_here

# ── سلة (Salla Partner API) ─────────────────────────
SALLA_CLIENT_ID=your_client_id
SALLA_CLIENT_SECRET=your_client_secret
SALLA_REDIRECT_URI=http://localhost:3000/callback

# ── Meta Ads (Facebook / Instagram) ─────────────────
META_ACCESS_TOKEN=your_meta_token

# ── TikTok Ads ───────────────────────────────────────
TIKTOK_ACCESS_TOKEN=your_tiktok_token
TIKTOK_APP_ID=your_app_id

# ── Google Drive (اختياري) ───────────────────────────
GOOGLE_DRIVE_CLIENT_ID=optional
GOOGLE_DRIVE_CLIENT_SECRET=optional
```

> 💡 **ملاحظة:** بدون مفاتيح API سيعمل التطبيق بـ **Simulated Mode** مع بيانات تجريبية كاملة.

### 3️⃣ تشغيل التطبيق

```bash
# التطوير (مع Hot Reload)
npm run dev

# الإنتاج
npm start
```

🌐 **افتح المتصفح:** [http://localhost:3000](http://localhost:3000)

---

## 🔌 API Endpoints الرئيسية

<details>
<summary>📋 <b>المصادقة (Auth)</b> — اضغط للتوسيع</summary>

| Method | Endpoint | الوصف |
|--------|----------|-------|
| `GET` | `/api/auth/salla` | بدء OAuth مع سلة |
| `GET` | `/callback` | استقبال Token من سلة |
| `GET` | `/api/auth/status` | فحص حالة الجلسة |
| `POST` | `/api/auth/logout` | تسجيل الخروج |

</details>

<details>
<summary>🛒 <b>الطلبات والمبيعات</b> — اضغط للتوسيع</summary>

| Method | Endpoint | الوصف |
|--------|----------|-------|
| `GET` | `/api/orders` | قائمة الطلبات |
| `GET` | `/api/orders/stats` | إحصائيات المبيعات |
| `POST` | `/api/import/excel` | استيراد Excel |
| `GET` | `/api/revenue` | تقرير الإيرادات |

</details>

<details>
<summary>💰 <b>المصروفات والمحاسبة</b> — اضغط للتوسيع</summary>

| Method | Endpoint | الوصف |
|--------|----------|-------|
| `GET` | `/api/expenses` | قائمة المصروفات |
| `POST` | `/api/expenses` | إضافة مصروف |
| `GET` | `/api/profit` | حساب الأرباح |
| `GET` | `/api/archive` | الأرشيف الشهري |

</details>

<details>
<summary>📢 <b>الإعلانات (Meta + TikTok)</b> — اضغط للتوسيع</summary>

| Method | Endpoint | الوصف |
|--------|----------|-------|
| `GET` | `/api/meta/campaigns` | حملات Meta Ads |
| `GET` | `/api/meta/campaign/:id` | تفاصيل حملة |
| `GET` | `/api/tiktok/campaigns` | حملات TikTok Ads |
| `GET` | `/api/ads/metrics` | ROAS, POAS, CAC, AOV |

</details>

---

## ☁️ النشر على السيرفر (Deployment)

```bash
# 1. رفع الملفات (بدون node_modules)
rsync -av --exclude='node_modules' --exclude='.env' ./ user@server:/app/

# 2. على السيرفر
cd /app
npm install --production

# 3. تشغيل مع PM2
pm2 start server.js --name shopdashboard
pm2 save
```

### منصات الاستضافة المدعومة

| المنصة | النوع | الملاحظة |
|--------|-------|---------|
| 🌊 **DigitalOcean** | VPS | موصى به للإنتاج |
| ☁️ **AWS EC2** | Cloud | مرونة عالية |
| 🚀 **Render** | PaaS | سهل وسريع |
| 🟢 **Heroku** | PaaS | مناسب للاختبار |
| 🏠 **Hostinger VPS** | VPS | اقتصادي |

---

## 🛠️ كيفية الحصول على مفاتيح سلة

```
الخطوة 1 ── سجّل في بوابة شركاء سلة
            https://salla.dev
               │
               ▼
الخطوة 2 ── أنشئ تطبيقاً جديداً
            My Apps → Create New App
               │
               ▼
الخطوة 3 ── اضبط Redirect URI
            http://localhost:3000/callback
               │
               ▼
الخطوة 4 ── فعّل الصلاحيات (Scopes)
            ✓ offline_access  ✓ profile
            ✓ orders.r        ✓ products.r
            ✓ customers.r
               │
               ▼
الخطوة 5 ── انسخ Client ID و Client Secret
            وضعهما في ملف .env
               │
               ▼
الخطوة 6 ── 🎉 ابدأ بربط متجرك!
```

---

## 🧪 الاختبارات

```bash
# تشغيل جميع الاختبارات
npm test

# الاختبارات موجودة في
tests/
├── auth.test.js        ← اختبارات المصادقة
├── orders.test.js      ← اختبارات الطلبات
└── expenses.test.js    ← اختبارات المصروفات
```

---

## 🔐 الأمان

```
🛡️ Helmet.js          ← Security Headers تلقائية
⚡ Rate Limiting        ← حد 100 طلب/دقيقة لكل IP
🍪 Cookie Sessions      ← جلسات محمية بـ HttpOnly
🚫 CORS Protection      ← قائمة بيضاء للـ Origins
🔒 Auth Middleware       ← حماية كل الـ API endpoints
```

---

## 📜 الترخيص

```
MIT License
Copyright © 2026 Eissa Ali | ShopDashboard
```

---

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=6,11,20&height=100&section=footer&animation=twinkling" width="100%"/>

**صُنع بـ ❤️ لأصحاب متاجر سلة 🛒**

[![Node](https://img.shields.io/badge/Powered%20by-Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Salla](https://img.shields.io/badge/Integrated%20with-Salla-7B2FBE?style=for-the-badge)](https://salla.dev/)

⭐ **إذا أفادك المشروع، لا تنسَ النجمة!** ⭐

</div>
