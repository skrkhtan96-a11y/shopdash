(function() {
    // 1. مساعدات إدارة الكوكيز
    function setCookie(name, value, days) {
        var expires = "";
        if (days) {
            var date = new Date();
            date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
            expires = "; expires=" + date.toUTCString();
        }
        document.cookie = name + "=" + (value || "") + expires + "; path=/; SameSite=Lax; Secure";
    }

    function getCookie(name) {
        var nameEQ = name + "=";
        var ca = document.cookie.split(';');
        for (var i = 0; i < ca.length; i++) {
            var c = ca[i];
            while (c.charAt(0) == ' ') c = c.substring(1, c.length);
            if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
        }
        return null;
    }

    // 2. توليد معرف الزائر الفريد
    function generateUUID() {
        return 'sd_vid_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
    }

    var sd_vid = getCookie('sd_vid');
    if (!sd_vid) {
        sd_vid = generateUUID();
        setCookie('sd_vid', sd_vid, 30); // صالح لـ 30 يوماً
    }

    // 3. استخراج الوسوم من الرابط
    var urlParams = new URLSearchParams(window.location.search);
    var utm_source = urlParams.get('utm_source');
    var utm_medium = urlParams.get('utm_medium');
    var utm_campaign = urlParams.get('utm_campaign');
    var utm_content = urlParams.get('utm_content');
    var utm_term = urlParams.get('utm_term');

    var fbclid = urlParams.get('fbclid');
    var ttclid = urlParams.get('ttclid');
    var sclid = urlParams.get('sclid');

    // كوكيز ميتا الإعلانية
    var fbp = getCookie('_fbp') || '';
    var fbc = getCookie('_fbc') || '';

    // تحديد خادم التتبع الخاص بـ ShopDash
    // يقوم السكربت بالاستعلام عن الدومين الحالي لمعرفة النطاق المستهدف تلقائياً
    var currentScript = document.currentScript;
    var serverUrl = 'https://shop.nuzum.sbs';
    if (currentScript && currentScript.src) {
        try {
            var srcUrl = new URL(currentScript.src);
            serverUrl = srcUrl.origin;
        } catch(e) {}
    }

    var isAttributionVisit = utm_source || utm_medium || utm_campaign || fbclid || ttclid || sclid;

    // 4. إرسال حدث الزيارة في حال وجود معطيات إسناد
    if (isAttributionVisit) {
        var payload = {
            sd_vid: sd_vid,
            utm_source: utm_source,
            utm_medium: utm_medium,
            utm_campaign: utm_campaign,
            utm_content: utm_content,
            utm_term: utm_term,
            fbclid: fbclid,
            ttclid: ttclid,
            sclid: sclid,
            fbp: fbp,
            fbc: fbc,
            referrer: document.referrer || '',
            url: window.location.href
        };

        // نستخدم fetch لإرسال البيانات للخلفية بشكل غير مرئي
        fetch(serverUrl + '/api/attribution/collect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            mode: 'cors'
        }).catch(function(e) {
            console.warn('[ShopDash Tracker] Error collecting attribution:', e);
        });
    }

    // 5. كشف صفحة الشكر (تأكيد الطلب) وإجراء الربط
    function detectSallaOrderId() {
        // أ. فحص كائن سلة البرمجي
        if (window.salla && typeof window.salla.config === 'object') {
            try {
                var id = window.salla.config.orderId || window.salla.config.get('order.id');
                if (id) return String(id);
            } catch(e) {}
        }
        if (window.Salla && window.Salla.order && window.Salla.order.id) {
            return String(window.Salla.order.id);
        }

        // ب. فحص معاملات الرابط
        if (urlParams.has('order_id')) return urlParams.get('order_id');
        if (urlParams.has('id')) return urlParams.get('id');

        // ج. فحص جزء من مسار الرابط
        var pathSegments = window.location.pathname.split('/');
        var thankYouIndex = pathSegments.indexOf('thank-you');
        if (thankYouIndex !== -1 && pathSegments[thankYouIndex + 1]) {
            return pathSegments[thankYouIndex + 1];
        }

        // د. قراءة العناصر الشائعة في قوالب سلة
        var orderEl = document.querySelector('.order-number, .order-id, #order-id, [data-order-id]');
        if (orderEl) {
            var textId = orderEl.getAttribute('data-order-id') || orderEl.textContent.trim().replace(/[^0-9]/g, '');
            if (textId) return String(textId);
        }
        return null;
    }

    // الانتظار حتى اكتمال تحميل الصفحة للتأكد من توفر عناصر سلة البرمجية والـ DOM
    window.addEventListener('load', function() {
        var orderId = detectSallaOrderId();
        var isThankYouPage = window.location.pathname.indexOf('/thank-you') !== -1 || 
                             window.location.pathname.indexOf('/checkout/thank-you') !== -1 ||
                             orderId;

        if (isThankYouPage && orderId) {
            var bindPayload = {
                order_id: orderId,
                sd_vid: sd_vid
            };

            fetch(serverUrl + '/api/attribution/bind', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bindPayload),
                mode: 'cors'
            }).then(function(res) {
                return res.json();
            }).then(function(data) {
                console.log('[ShopDash Tracker] Order successfully bound:', data);
            }).catch(function(e) {
                console.warn('[ShopDash Tracker] Error binding order:', e);
            });
        }
    });
})();
