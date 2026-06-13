"""
شوب ستور — WhatsApp Automation Bot
====================================
يستقبل webhooks من سلة عند كل طلب جديد،
يجمع البيانات من سلة + Meta Pixel،
ويرسل تقرير شامل على واتساب.
"""

import os
import hmac
import hashlib
import logging
import requests
from datetime import datetime, timezone, timedelta
from flask import Flask, request, jsonify
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sho9_bot")

app = Flask(__name__)

# ─── Config ───────────────────────────────────────────────────────────────────
SALLA_APP_SECRET      = os.getenv("SALLA_APP_SECRET", "")
META_PIXEL_ID         = os.getenv("META_PIXEL_ID", "992972159819465")
META_CAMPAIGN_ID      = os.getenv("META_CAMPAIGN_ID", "120248463358590034")
META_AD_ACCOUNT_ID    = os.getenv("META_AD_ACCOUNT_ID", "667473139514102")
WA_PHONE_NUMBER_ID    = os.getenv("WA_PHONE_NUMBER_ID", "152632267938763")
REPORT_PHONE          = os.getenv("REPORT_PHONE", "966558619232")  # رقم المستلم
KSA_TZ               = timezone(timedelta(hours=3))

def get_salla_token() -> str:
    db_path = "/var/www/shopdashboard/database.db"
    if not os.path.exists(db_path):
        db_path = "database.db"
    if os.path.exists(db_path):
        try:
            import sqlite3
            import json
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM salla_config WHERE key = 'salla_auth'")
            row = cursor.fetchone()
            conn.close()
            if row and row[0]:
                data = json.loads(row[0])
                return data.get("access_token", "")
        except Exception as e:
            log.error(f"Failed to read Salla token from SQLite: {e}")
    return os.getenv("SALLA_ACCESS_TOKEN", "")

def get_meta_token() -> str:
    db_path = "/var/www/shopdashboard/database.db"
    if not os.path.exists(db_path):
        db_path = "database.db"
    if os.path.exists(db_path):
        try:
            import sqlite3
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            cursor.execute("SELECT access_token FROM ads_connections WHERE platform = 'facebook'")
            row = cursor.fetchone()
            conn.close()
            if row and row[0]:
                return row[0]
        except Exception as e:
            log.error(f"Failed to read Meta token from SQLite: {e}")
    return os.getenv("META_ACCESS_TOKEN", "")

# ─── Signature Verification ────────────────────────────────────────────────────
def verify_salla_signature(payload: bytes, sig_header: str) -> bool:
    if not SALLA_APP_SECRET or not sig_header:
        return True  # Dev mode: skip
    expected = hmac.new(SALLA_APP_SECRET.encode(), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig_header.replace("sha256=", ""))


# ─── Salla API helpers ─────────────────────────────────────────────────────────
def get_salla_order(order_id: int) -> dict:
    """جلب تفاصيل طلب محدد من سلة."""
    url = f"https://api.salla.dev/admin/v2/orders/{order_id}"
    headers = {"Authorization": f"Bearer {get_salla_token()}"}
    r = requests.get(url, headers=headers, timeout=10)
    r.raise_for_status()
    return r.json().get("data", {})


def get_today_sales_summary() -> dict:
    """ملخص مبيعات اليوم من سلة."""
    today = datetime.now(KSA_TZ).strftime("%Y-%m-%d")
    url = "https://api.salla.dev/admin/v2/orders"
    headers = {"Authorization": f"Bearer {get_salla_token()}"}
    params = {"from_date": today, "to_date": today, "sort_by": "created_at"}
    r = requests.get(url, headers=headers, params=params, timeout=10)
    if not r.ok:
        return {"total": 0, "completed": 0, "revenue": 0}

    orders = r.json().get("data", [])
    completed = [o for o in orders if o.get("status", {}).get("slug") == "completed"]
    revenue = sum(float(o.get("total", {}).get("amount", 0)) for o in completed)
    return {
        "total": r.json().get("pagination", {}).get("total", len(orders)),
        "completed": len(completed),
        "revenue": round(revenue, 2),
    }


# ─── Meta Pixel helper ─────────────────────────────────────────────────────────
def get_pixel_last_hour() -> dict:
    """إحصائيات البكسل للساعة الأخيرة."""
    now_ts = int(datetime.now(timezone.utc).timestamp())
    hour_ago = now_ts - 3600
    url = f"https://graph.facebook.com/v19.0/{META_PIXEL_ID}/stats"
    params = {
        "access_token": get_meta_token(),
        "aggregation": "event",
        "start_time": str(hour_ago),
        "end_time": str(now_ts),
    }
    r = requests.get(url, params=params, timeout=10)
    if not r.ok:
        return {}
    data = r.json().get("data", [])
    counts = {}
    for bucket in data:
        for item in bucket.get("data", []):
            ev = item.get("value", "")
            counts[ev] = counts.get(ev, 0) + item.get("count", 0)
    return counts


def get_campaign_status() -> dict:
    """حالة حملة ميتا."""
    url = f"https://graph.facebook.com/v19.0/{META_CAMPAIGN_ID}"
    params = {
        "access_token": get_meta_token(),
        "fields": "name,status,daily_budget,effective_status",
    }
    r = requests.get(url, params=params, timeout=10)
    if not r.ok:
        return {"status": "UNKNOWN", "name": "—", "daily_budget": "—"}
    d = r.json()
    budget_sar = round(int(d.get("daily_budget", 0)) / 100, 0)
    return {
        "name": d.get("name", "—"),
        "status": d.get("effective_status", d.get("status", "—")),
        "daily_budget": f"{budget_sar:.0f} ر.س",
    }


# ─── Detect Campaign Source ────────────────────────────────────────────────────
def is_from_campaign(order: dict) -> bool:
    """
    يتحقق إذا كان الطلب قادماً من الحملة الإعلانية.
    سلة تُخزّن مصدر الطلب في حقل source أو utm_source.
    الحملة الجديدة تستهدف sho9.com/-/c1236214729
    """
    source = (order.get("source") or "").lower()
    meta_sources = {"instagram", "facebook", "meta", "fb"}
    # أي طلب مصدره إنستقرام/فيسبوك يُحتسب من الحملة
    if source in meta_sources:
        return True
    # أو source يبدأ بـ "120248" (campaign ID prefix في UTMs)
    if source.startswith("12024846335"):
        return True
    return False


# ─── Build WhatsApp Report Message ────────────────────────────────────────────
def build_report(order: dict, sales: dict, pixel: dict, campaign: dict) -> str:
    now_ksa = datetime.now(KSA_TZ).strftime("%d/%m/%Y %H:%M")
    order_ref  = order.get("reference_id", "—")
    customer   = order.get("customer", {})
    cust_name  = customer.get("full_name", "—")
    cust_phone = f"{customer.get('mobile_code','')} {customer.get('mobile','')}"
    cust_city  = customer.get("city") or customer.get("country") or "—"
    items      = order.get("items", [])
    products   = "\n".join(f"  • {i.get('name','—')} × {i.get('quantity',1)}" for i in items)
    amount     = order.get("total", {})
    order_amt  = f"{amount.get('amount','—')} {amount.get('currency','SAR')}"
    pay_method = order.get("payment_method", "—")
    order_url  = order.get("urls", {}).get("admin", "—")
    order_status = order.get("status", {}).get("name", "—")

    pv   = pixel.get("PageView", 0)
    pur  = pixel.get("Purchase", 0)
    chk  = pixel.get("InitiateCheckout", 0)
    atc  = pixel.get("AddToCart", 0)

    cam_status = campaign.get("status", "—")
    cam_badge  = "✅ نشطة" if cam_status in ("ACTIVE", "CAMPAIGN_PAUSED") else "⏸ متوقفة"

    msg = f"""🛍️ *طلب جديد — شوب ستور*
📅 {now_ksa}
━━━━━━━━━━━━━━━━━━━
🔖 *رقم الطلب:* #{order_ref}
👤 *العميل:* {cust_name}
📍 *الموقع:* {cust_city}
📞 *الجوال:* {cust_phone}
💳 *طريقة الدفع:* {pay_method}
📦 *المنتجات:*
{products}
💰 *القيمة:* {order_amt}
🟢 *الحالة:* {order_status}

━━━━━━━━━━━━━━━━━━━
📊 *ملخص اليوم (سلة):*
• إجمالي الطلبات: {sales['total']}
• مكتملة: {sales['completed']}
• إيرادات اليوم: {sales['revenue']} ر.س

━━━━━━━━━━━━━━━━━━━
🎯 *حملة ميتا أدز:*
• الحالة: {cam_badge}
• الميزانية: {campaign['daily_budget']}
• Campaign ID: {META_CAMPAIGN_ID}

━━━━━━━━━━━━━━━━━━━
📡 *بكسل فارس (آخر ساعة):*
• PageView: {pv}
• AddToCart: {atc}
• Checkout: {chk}
• Purchase: {pur}

🔗 {order_url}"""
    return msg


# ─── Send WhatsApp Message ─────────────────────────────────────────────────────
def send_whatsapp(phone: str, message: str) -> bool:
    """إرسال رسالة نصية عبر WhatsApp Cloud API."""
    url = f"https://graph.facebook.com/v19.0/{WA_PHONE_NUMBER_ID}/messages"
    headers = {
        "Authorization": f"Bearer {get_meta_token()}",
        "Content-Type": "application/json",
    }
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": phone,
        "type": "text",
        "text": {"preview_url": False, "body": message},
    }
    r = requests.post(url, headers=headers, json=payload, timeout=15)
    if r.ok:
        log.info(f"✅ WhatsApp sent to {phone}")
        return True
    log.error(f"❌ WhatsApp failed: {r.status_code} {r.text}")
    return False


# ─── Webhook Endpoint ──────────────────────────────────────────────────────────
@app.route("/webhook/salla", methods=["POST"])
def salla_webhook():
    payload = request.get_data()

    # Verify signature
    sig = request.headers.get("X-Salla-Signature", "")
    if not verify_salla_signature(payload, sig):
        log.warning("Invalid Salla signature")
        return jsonify({"error": "unauthorized"}), 401

    data = request.get_json(force=True, silent=True) or {}
    event = data.get("event", "")
    log.info(f"Received Salla event: {event}")

    # فقط أحداث الطلبات الجديدة
    if event not in ("order.created", "order.updated", "order.status.updated"):
        return jsonify({"ok": True, "skipped": event}), 200

    order_data = data.get("data", {})
    order_id   = order_data.get("id") or order_data.get("order_id")
    if not order_id:
        return jsonify({"ok": True, "skipped": "no order_id"}), 200

    # جلب تفاصيل الطلب الكاملة
    try:
        order = get_salla_order(order_id)
    except Exception as e:
        log.error(f"Failed to fetch order {order_id}: {e}")
        order = order_data

    # التحقق من مصدر الحملة
    from_campaign = is_from_campaign(order)

    # جمع البيانات بالتوازي
    try:
        sales    = get_today_sales_summary()
        pixel    = get_pixel_last_hour()
        campaign = get_campaign_status()
    except Exception as e:
        log.error(f"Data fetch error: {e}")
        sales, pixel, campaign = {"total": "?", "completed": "?", "revenue": "?"}, {}, {}

    # بناء الرسالة
    report = build_report(order, sales, pixel, campaign)

    # إضافة تنبيه مصدر الحملة
    if from_campaign:
        report = "🎯 *هذا الطلب من الحملة الإعلانية!*\n\n" + report

    # إرسال التقرير
    send_whatsapp(REPORT_PHONE, report)

    return jsonify({"ok": True, "order_id": order_id, "from_campaign": from_campaign}), 200


# ─── Health Check ──────────────────────────────────────────────────────────────
@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "time_ksa": datetime.now(KSA_TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "wa_phone": REPORT_PHONE,
        "pixel": META_PIXEL_ID,
        "campaign": META_CAMPAIGN_ID,
    })


@app.route("/test", methods=["GET"])
def test_send():
    """اختبار يدوي — أرسل تقرير تجريبي."""
    dummy_order = {
        "reference_id": "TEST-001",
        "source": "instagram",
        "status": {"name": "تم التنفيذ", "slug": "completed"},
        "total": {"amount": "27.99", "currency": "SAR"},
        "payment_method": "مدى",
        "customer": {
            "full_name": "عميل تجريبي",
            "mobile": "5XXXXXXXX",
            "mobile_code": "+966",
            "city": "الرياض",
        },
        "items": [{"name": "بلس ايفون — الباقة الذهبية", "quantity": 1}],
        "urls": {"admin": "https://s.salla.sa/orders"},
    }
    sales    = get_today_sales_summary()
    pixel    = get_pixel_last_hour()
    campaign = get_campaign_status()
    report   = "🧪 *رسالة تجريبية*\n\n" + build_report(dummy_order, sales, pixel, campaign)
    ok = send_whatsapp(REPORT_PHONE, report)
    return jsonify({"sent": ok, "to": REPORT_PHONE})


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
