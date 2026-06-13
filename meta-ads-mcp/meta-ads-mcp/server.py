"""
Meta Ads MCP Server
يتصل بـ Meta Marketing API ويوفر أدوات لإدارة الإعلانات عبر Claude
"""

import os
import json
import asyncio
import httpx
from datetime import datetime, timedelta
from typing import Any
from mcp.server import Server
from mcp.server.sse import SseServerTransport
from mcp.types import Tool, TextContent
from starlette.applications import Starlette
from starlette.routing import Route, Mount
from starlette.requests import Request
from starlette.responses import JSONResponse
import uvicorn

# ── إعدادات ──────────────────────────────────────────────
META_API_VERSION = "v21.0"
META_API_BASE = f"https://graph.facebook.com/{META_API_VERSION}"
ACCESS_TOKEN = os.environ.get("META_ACCESS_TOKEN", "")
AD_ACCOUNT_ID = os.environ.get("META_AD_ACCOUNT_ID", "")  # بدون act_

app_server = Server("meta-ads-mcp")

# ── دالة مساعدة للـ API ───────────────────────────────────
async def meta_get(endpoint: str, params: dict = {}) -> dict:
    params["access_token"] = ACCESS_TOKEN
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(f"{META_API_BASE}{endpoint}", params=params)
        return r.json()

async def meta_post(endpoint: str, data: dict = {}) -> dict:
    data["access_token"] = ACCESS_TOKEN
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(f"{META_API_BASE}{endpoint}", data=data)
        return r.json()

# ── تعريف الأدوات ─────────────────────────────────────────
@app_server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="get_campaigns_performance",
            description="جلب أداء الحملات الإعلانية (الإنفاق، ROAS، CPA، CTR) لفترة زمنية محددة",
            inputSchema={
                "type": "object",
                "properties": {
                    "days": {
                        "type": "integer",
                        "description": "عدد الأيام الماضية (مثال: 7 أو 30)",
                        "default": 7
                    }
                }
            }
        ),
        Tool(
            name="get_ads_performance",
            description="جلب أداء الإعلانات الفردية مع تفاصيل الإنفاق والنتائج",
            inputSchema={
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "default": 7},
                    "limit": {"type": "integer", "default": 20}
                }
            }
        ),
        Tool(
            name="pause_ad_set",
            description="إيقاف مجموعة إعلانية (Ad Set) بناءً على ID",
            inputSchema={
                "type": "object",
                "properties": {
                    "adset_id": {"type": "string", "description": "معرّف مجموعة الإعلانات"}
                },
                "required": ["adset_id"]
            }
        ),
        Tool(
            name="scale_adset_budget",
            description="زيادة أو تخفيض ميزانية مجموعة إعلانية بنسبة مئوية",
            inputSchema={
                "type": "object",
                "properties": {
                    "adset_id": {"type": "string"},
                    "percentage": {"type": "number", "description": "نسبة التغيير (مثال: 20 لزيادة 20%)"}
                },
                "required": ["adset_id", "percentage"]
            }
        ),
        Tool(
            name="get_adsets_performance",
            description="جلب أداء مجموعات الإعلانات مع ROAS والإنفاق لاكتشاف الرابحة والخاسرة",
            inputSchema={
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "default": 7}
                }
            }
        ),
        Tool(
            name="morning_check",
            description="تقرير صباحي شامل: أداء الأمس + توصيات فورية",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        Tool(
            name="get_account_info",
            description="معلومات حساب الإعلانات والرصيد المتاح",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
    ]

# ── تنفيذ الأدوات ─────────────────────────────────────────
@app_server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    account_id = f"act_{AD_ACCOUNT_ID}"

    # ── فحص الإعداد ───────────────────────────────────────
    if not ACCESS_TOKEN or not AD_ACCOUNT_ID:
        return [TextContent(type="text", text="❌ خطأ: متغيرات البيئة META_ACCESS_TOKEN و META_AD_ACCOUNT_ID غير مضبوطة")]

    try:

        # ── أداء الحملات ───────────────────────────────────
        if name == "get_campaigns_performance":
            days = arguments.get("days", 7)
            date_preset = f"last_{days}_d" if days in [7, 14, 28, 30] else "last_7d"
            data = await meta_get(f"/{account_id}/campaigns", {
                "fields": "name,status,insights{spend,impressions,clicks,ctr,cpm,actions,action_values}",
                "date_preset": date_preset,
                "limit": 20
            })
            campaigns = data.get("data", [])
            if not campaigns:
                return [TextContent(type="text", text="لا توجد حملات في هذه الفترة")]

            result = f"📊 **أداء الحملات — آخر {days} أيام**\n\n"
            for c in campaigns:
                insights = c.get("insights", {}).get("data", [{}])[0] if c.get("insights") else {}
                spend = float(insights.get("spend", 0))
                clicks = int(insights.get("clicks", 0))
                impressions = int(insights.get("impressions", 0))
                ctr = float(insights.get("ctr", 0))

                # حساب التحويلات والإيرادات
                actions = insights.get("actions", [])
                purchases = sum(float(a.get("value", 0)) for a in actions if a.get("action_type") == "purchase")
                action_values = insights.get("action_values", [])
                revenue = sum(float(a.get("value", 0)) for a in action_values if a.get("action_type") == "purchase")
                roas = round(revenue / spend, 2) if spend > 0 else 0
                cpa = round(spend / purchases, 2) if purchases > 0 else 0

                status_icon = "🟢" if c.get("status") == "ACTIVE" else "⏸️"
                result += f"{status_icon} **{c['name']}**\n"
                result += f"   💰 إنفاق: ${spend:.2f} | ROAS: {roas}x | CPA: ${cpa:.2f}\n"
                result += f"   👆 CTR: {ctr:.2f}% | نقرات: {clicks:,} | مشاهدات: {impressions:,}\n\n"

            return [TextContent(type="text", text=result)]

        # ── أداء الإعلانات الفردية ─────────────────────────
        elif name == "get_ads_performance":
            days = arguments.get("days", 7)
            limit = arguments.get("limit", 20)
            data = await meta_get(f"/{account_id}/ads", {
                "fields": "name,status,adset_id,insights{spend,impressions,clicks,ctr,frequency,actions,action_values}",
                "date_preset": f"last_{days}_d" if days in [7, 14, 28, 30] else "last_7d",
                "limit": limit
            })
            ads = data.get("data", [])
            if not ads:
                return [TextContent(type="text", text="لا توجد إعلانات في هذه الفترة")]

            result = f"🎯 **أداء الإعلانات — آخر {days} أيام**\n\n"
            for ad in ads:
                insights = ad.get("insights", {}).get("data", [{}])[0] if ad.get("insights") else {}
                spend = float(insights.get("spend", 0))
                if spend == 0:
                    continue
                ctr = float(insights.get("ctr", 0))
                freq = float(insights.get("frequency", 0))
                action_values = insights.get("action_values", [])
                revenue = sum(float(a.get("value", 0)) for a in action_values if a.get("action_type") == "purchase")
                roas = round(revenue / spend, 2) if spend > 0 else 0

                status_icon = "🟢" if ad.get("status") == "ACTIVE" else "⏸️"
                roas_icon = "🔥" if roas >= 3 else ("⚠️" if roas < 1.5 else "✅")
                result += f"{status_icon} **{ad['name']}**\n"
                result += f"   {roas_icon} ROAS: {roas}x | إنفاق: ${spend:.2f} | تكرار: {freq:.1f}\n"
                result += f"   CTR: {ctr:.2f}%\n\n"

            return [TextContent(type="text", text=result)]

        # ── أداء مجموعات الإعلانات ────────────────────────
        elif name == "get_adsets_performance":
            days = arguments.get("days", 7)
            data = await meta_get(f"/{account_id}/adsets", {
                "fields": "name,status,daily_budget,insights{spend,actions,action_values}",
                "date_preset": f"last_{days}_d" if days in [7, 14, 28, 30] else "last_7d",
                "limit": 30
            })
            adsets = data.get("data", [])
            if not adsets:
                return [TextContent(type="text", text="لا توجد مجموعات إعلانية")]

            winners, losers, neutral = [], [], []
            for a in adsets:
                insights = a.get("insights", {}).get("data", [{}])[0] if a.get("insights") else {}
                spend = float(insights.get("spend", 0))
                if spend < 10:
                    continue
                action_values = insights.get("action_values", [])
                revenue = sum(float(x.get("value", 0)) for x in action_values if x.get("action_type") == "purchase")
                roas = round(revenue / spend, 2) if spend > 0 else 0
                budget = int(a.get("daily_budget", 0)) / 100
                item = {"name": a["name"], "id": a["id"], "roas": roas, "spend": spend, "budget": budget, "status": a.get("status")}
                if roas >= 3:
                    winners.append(item)
                elif roas < 1.5 and spend >= 50:
                    losers.append(item)
                else:
                    neutral.append(item)

            result = f"📊 **مجموعات الإعلانات — آخر {days} أيام**\n\n"
            if winners:
                result += "🔥 **رابحة — يُنصح بالتضخيم:**\n"
                for w in winners:
                    result += f"  • {w['name']} | ROAS: {w['roas']}x | إنفاق: ${w['spend']:.0f} | ميزانية: ${w['budget']:.0f}/يوم\n"
                result += "\n"
            if losers:
                result += "⚠️ **خاسرة — يُنصح بالإيقاف:**\n"
                for l in losers:
                    result += f"  • {l['name']} | ROAS: {l['roas']}x | إنفاق: ${l['spend']:.0f}\n"
                result += "\n"
            if neutral:
                result += "⏳ **متوسطة — تحتاج مراقبة:**\n"
                for n in neutral:
                    result += f"  • {n['name']} | ROAS: {n['roas']}x\n"

            return [TextContent(type="text", text=result)]

        # ── إيقاف مجموعة إعلانية ──────────────────────────
        elif name == "pause_ad_set":
            adset_id = arguments["adset_id"]
            result = await meta_post(f"/{adset_id}", {"status": "PAUSED"})
            if result.get("success"):
                return [TextContent(type="text", text=f"✅ تم إيقاف المجموعة الإعلانية {adset_id} بنجاح")]
            else:
                return [TextContent(type="text", text=f"❌ فشل الإيقاف: {json.dumps(result, ensure_ascii=False)}")]

        # ── تضخيم الميزانية ────────────────────────────────
        elif name == "scale_adset_budget":
            adset_id = arguments["adset_id"]
            pct = arguments["percentage"]
            info = await meta_get(f"/{adset_id}", {"fields": "daily_budget,name"})
            current_budget = int(info.get("daily_budget", 0))
            new_budget = int(current_budget * (1 + pct / 100))
            result = await meta_post(f"/{adset_id}", {"daily_budget": new_budget})
            if result.get("success"):
                return [TextContent(type="text", text=f"✅ **{info.get('name')}**\n   ميزانية قديمة: ${current_budget/100:.2f}/يوم\n   ميزانية جديدة: ${new_budget/100:.2f}/يوم (+{pct}%)")]
            else:
                return [TextContent(type="text", text=f"❌ فشل التحديث: {json.dumps(result, ensure_ascii=False)}")]

        # ── معلومات الحساب ─────────────────────────────────
        elif name == "get_account_info":
            data = await meta_get(f"/{account_id}", {
                "fields": "name,currency,balance,amount_spent,account_status"
            })
            status_map = {1: "🟢 نشط", 2: "⏸️ موقوف", 3: "❌ محذوف", 7: "⚠️ معلق"}
            status = status_map.get(data.get("account_status"), "غير معروف")
            balance = int(data.get("balance", 0)) / 100
            spent = int(data.get("amount_spent", 0)) / 100
            result = f"💼 **{data.get('name', 'حساب الإعلانات')}**\n"
            result += f"   الحالة: {status}\n"
            result += f"   الرصيد: ${balance:.2f}\n"
            result += f"   إجمالي الإنفاق: ${spent:.2f}\n"
            result += f"   العملة: {data.get('currency', 'USD')}\n"
            return [TextContent(type="text", text=result)]

        # ── التقرير الصباحي ────────────────────────────────
        elif name == "morning_check":
            # جلب البيانات بالتوازي
            account_task = meta_get(f"/{account_id}", {"fields": "name,currency,balance"})
            adsets_task = meta_get(f"/{account_id}/adsets", {
                "fields": "name,status,id,daily_budget,insights{spend,actions,action_values,frequency}",
                "date_preset": "yesterday",
                "limit": 50
            })
            account_data, adsets_data = await asyncio.gather(account_task, adsets_task)

            adsets = adsets_data.get("data", [])
            total_spend = 0
            total_revenue = 0
            to_pause = []
            to_scale = []
            fatigue = []

            for a in adsets:
                if a.get("status") != "ACTIVE":
                    continue
                insights = a.get("insights", {}).get("data", [{}])[0] if a.get("insights") else {}
                spend = float(insights.get("spend", 0))
                if spend == 0:
                    continue
                total_spend += spend
                action_values = insights.get("action_values", [])
                revenue = sum(float(x.get("value", 0)) for x in action_values if x.get("action_type") == "purchase")
                total_revenue += revenue
                roas = round(revenue / spend, 2) if spend > 0 else 0
                freq = float(insights.get("frequency", 0))

                if roas < 1.5 and spend >= 50:
                    to_pause.append({"name": a["name"], "id": a["id"], "roas": roas, "spend": spend})
                if roas >= 3.0:
                    to_scale.append({"name": a["name"], "id": a["id"], "roas": roas, "budget": int(a.get("daily_budget", 0)) / 100})
                if freq >= 3.5:
                    fatigue.append({"name": a["name"], "freq": freq})

            overall_roas = round(total_revenue / total_spend, 2) if total_spend > 0 else 0
            result = f"☀️ **التقرير الصباحي — {datetime.now().strftime('%Y/%m/%d')}**\n\n"
            result += f"💰 إنفاق الأمس: ${total_spend:.2f}\n"
            result += f"📈 إيرادات الأمس: ${total_revenue:.2f}\n"
            result += f"🎯 ROAS الكلي: {overall_roas}x\n\n"

            if to_pause:
                result += f"⚠️ **يُنصح بإيقافها ({len(to_pause)}):**\n"
                for p in to_pause:
                    result += f"  • {p['name']} — ROAS: {p['roas']}x | إنفاق: ${p['spend']:.0f}\n"
                result += "\n"

            if to_scale:
                result += f"🔥 **يُنصح بتضخيمها ({len(to_scale)}):**\n"
                for s in to_scale:
                    result += f"  • {s['name']} — ROAS: {s['roas']}x | ميزانية: ${s['budget']:.0f}/يوم\n"
                result += "\n"

            if fatigue:
                result += f"😴 **تعب إبداعي — تكرار عالٍ ({len(fatigue)}):**\n"
                for f in fatigue:
                    result += f"  • {f['name']} — تكرار: {f['freq']:.1f}x\n"
                result += "\n"

            if not to_pause and not to_scale and not fatigue:
                result += "✅ كل شيء يسير بشكل جيد — لا توجد إجراءات مطلوبة\n"

            return [TextContent(type="text", text=result)]

    except Exception as e:
        return [TextContent(type="text", text=f"❌ خطأ: {str(e)}")]

    return [TextContent(type="text", text="أداة غير معروفة")]

# ── إعداد Starlette ───────────────────────────────────────
sse = SseServerTransport("/messages/")

async def handle_sse(request: Request):
    async with sse.connect_sse(request.scope, request.receive, request._send) as streams:
        await app_server.run(streams[0], streams[1], app_server.create_initialization_options())

async def health(request: Request):
    return JSONResponse({"status": "ok", "server": "meta-ads-mcp", "account": AD_ACCOUNT_ID})

starlette_app = Starlette(routes=[
    Route("/health", health),
    Route("/sse", handle_sse),
    Mount("/messages/", app=sse.handle_post_message),
])

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(starlette_app, host="0.0.0.0", port=port)
