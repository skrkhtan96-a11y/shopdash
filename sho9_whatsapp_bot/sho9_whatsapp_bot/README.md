# 🤖 شوب ستور WhatsApp Bot — دليل التشغيل

## المتطلبات
- Python 3.11+
- حساب Meta Developer (عندك — app "nuzum")
- رقم WhatsApp Business API (Phone Number ID: 152632267938763)
- Salla App مثبت على المتجر (للـ Webhook)
- خادم عام (VPS / Railway / Render / ngrok للاختبار)

---

## الخطوة 1 — تحضير المتغيرات

```bash
cp .env.example .env
nano .env
```

### 1.1 SALLA_ACCESS_TOKEN
من لوحة التحكم في سلة:
- اذهب: s.salla.sa → التطبيقات → تطبيقك → OAuth
- انسخ Access Token

### 1.2 SALLA_APP_SECRET
- نفس الصفحة → App Secret

### 1.3 META_ACCESS_TOKEN
من Meta Business Suite:
- Business Settings → System Users → System User → Generate Token
- الصلاحيات: `whatsapp_business_messaging`, `ads_read`, `business_management`

### 1.4 WA_ACCESS_TOKEN
- نفس الـ System User Token أو:
- Meta Developer Console → WhatsApp → API Setup → Token

---

## الخطوة 2 — تشغيل محلي (اختبار)

```bash
pip install -r requirements.txt
python app/main.py
```

اختبر الـ Health Check:
```bash
curl http://localhost:5000/health
```

اختبر إرسال واتساب:
```bash
curl http://localhost:5000/test
```

---

## الخطوة 3 — نشر على Railway (الأسرع)

```bash
# ثبّت Railway CLI
npm install -g @railway/cli

# سجّل دخول
railway login

# أنشئ مشروع
railway init

# انشر
railway up

# أضف المتغيرات
railway variables set SALLA_ACCESS_TOKEN=xxx
railway variables set META_ACCESS_TOKEN=xxx
railway variables set WA_ACCESS_TOKEN=xxx
railway variables set SALLA_APP_SECRET=xxx
```

سيعطيك Railway رابطاً مثل:
`https://sho9-bot-production.up.railway.app`

---

## الخطوة 4 — ربط Webhook في سلة

1. اذهب: s.salla.sa → التطبيقات → تطبيقك → Webhooks
2. أضف Webhook جديد:
   - **URL**: `https://YOUR_DOMAIN/webhook/salla`
   - **Events** (اختر الثلاثة):
     - `order.created` ✅
     - `order.updated` ✅
     - `order.status.updated` ✅
3. احفظ

---

## الخطوة 5 — اختبار نهائي

أنشئ طلب تجريبي في سلة وراقب:

```bash
# سجلات الخادم
railway logs

# أو محلياً
python app/main.py
# افتح في المتصفح: http://localhost:5000/test
```

---

## بنية المشروع

```
sho9_whatsapp_bot/
├── app/
│   └── main.py          ← الكود الأساسي
├── .env                 ← المتغيرات (لا ترفعه لـ git)
├── .env.example         ← نموذج المتغيرات
├── requirements.txt
├── Dockerfile
└── README.md
```

---

## شكل الرسالة على واتساب

```
🛍️ طلب جديد — شوب ستور
📅 13/06/2026 15:52
━━━━━━━━━━━━━━━━━━━
🔖 رقم الطلب: #266119303
👤 العميل: عمر
📍 الموقع: ينبع
📞 الجوال: +966 534755901
💳 طريقة الدفع: مدى
📦 المنتجات:
  • بلس ايفون — الباقة الذهبية × 1
💰 القيمة: 27.99 SAR
🟢 الحالة: تم التنفيذ

━━━━━━━━━━━━━━━━━━━
📊 ملخص اليوم (سلة):
• إجمالي الطلبات: 54
• مكتملة: 9
• إيرادات اليوم: 271 ر.س

━━━━━━━━━━━━━━━━━━━
🎯 حملة ميتا أدز:
• الحالة: ✅ نشطة
• الميزانية: 50 ر.س
• Campaign ID: 120248463358590034

━━━━━━━━━━━━━━━━━━━
📡 بكسل فارس (آخر ساعة):
• PageView: 341
• AddToCart: 10
• Checkout: 28
• Purchase: 14

🔗 https://s.salla.sa/orders/...
```

---

## ملاحظات مهمة

- الرقم المستلم: **+966558619232**
- البوت يميّز الطلبات القادمة من إنستقرام/فيسبوك ويضع تنبيه "من الحملة الإعلانية"
- يعمل 24/7 بدون تدخل يدوي
- عند أي خطأ في الإرسال يُسجّل في logs الخادم
