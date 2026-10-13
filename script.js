// ==UserScript==
// @name         Sesión Segura - Canvas Poli y equipos compartidos
// @namespace    https://github.com/sesion-segura/userscript
// @version      1.1.0
// @description  Cierre de sesión asistido, temporizador de inactividad, limpieza de campos sensibles, recordatorios y alerta HTTP para Canvas (poli.instructure.com) y portales institucionales autorizados.
// @author       Gabriel Gómez Calderón
// @license      GPL3
// @match        https://poli.instructure.com/*
// @match        *://*.poli.edu.co/*
// @match        *://poli.edu.co/*
// @match        http://localhost/*
// @match        https://localhost/*
// @match        http://127.0.0.1/*
// @match        *://example.com/*
// @match        *://*.example.com/*
// @match        http://neverssl.com/*
// @match        *://httpforever.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
     * 1. CONFIGURACIÓN
     * ============================================================ */
    const VERSION = '1.1.0';
    const ROOT_ID = 'sps_root';
    const MAX_LOG = 20;

    const DEFAULTS = {
        cfgVersion: 2,
        testMode: false,         // Modo de prueba: no cierra sesiones reales
        showWidget: true,        // Botón flotante "Limpiar sesión"
        theme: 'auto',           // auto | light | dark
        inactivitySec: 300,      // Segundos de inactividad antes de advertir
        warningSec: 30,          // Segundos de advertencia antes de limpiar
        warnHttp: true,          // Alerta si la página no usa HTTPS
        clearPasswords: true,
        clearTokens: true,
        clearForms: true,
        wipeSession: true,       // sessionStorage
        wipeLocal: true,         // localStorage (borradores del editor, etc.)
        wipeCookies: false,      // cookies accesibles por JS (no HttpOnly)
        tryLogout: true,         // Intentar cierre de sesión asistido
        remindOnLoad: true,      // Recordatorio al abrir el portal (una vez por pestaña)
        remindMinutes: 20,       // Recordatorio periódico (0 = desactivado)
        domains: ['poli.instructure.com', 'poli.edu.co', 'localhost', '127.0.0.1', 'example.com', 'neverssl.com', 'httpforever.com']
    };

    function loadCfg() {
        let saved = {};
        try { saved = GM_getValue('config', {}) || {}; } catch (e) { saved = {}; }
        const c = Object.assign({}, DEFAULTS, saved);
        if (!Array.isArray(c.domains)) c.domains = DEFAULTS.domains.slice();
        if ((saved.cfgVersion || 1) < 2) {
            c.cfgVersion = 2;
            c.testMode = false;
            c.wipeSession = true;
            c.wipeLocal = true;
        }
        if (c.domains.indexOf('poli.instructure.com') === -1) c.domains.unshift('poli.instructure.com');
        return c;
    }
    function saveCfg() {
        try { GM_setValue('config', cfg); } catch (e) { console.warn('[SesiónSegura] No se pudo guardar', e); }
    }
    let cfg = loadCfg();
    saveCfg();
    const isCanvas = () => /(^|\.)instructure\.com$/i.test(location.hostname);

    function normDomain(d) {
        return String(d || '').trim().toLowerCase()
            .replace(/^[a-z]+:\/\//, '').replace(/^\*\./, '').replace(/^\./, '')
            .replace(/[\/?#].*$/, '').replace(/:\d+$/, '');
    }
    function hostAllowed(host) {
        host = String(host || '').toLowerCase();
        return cfg.domains.map(normDomain).filter(Boolean)
            .some(d => host === d || host.endsWith('.' + d));
    }

    /* Si el dominio no está autorizado, el script no hace nada salvo ofrecer autorizarlo */
    if (!hostAllowed(location.hostname)) {
        try {
            GM_registerMenuCommand('Autorizar este dominio (' + location.hostname + ') y recargar', function () {
                cfg.domains.push(location.hostname);
                saveCfg();
                location.reload();
            });
        } catch (e) { /* ignorar */ }
        return;
    }

    /* ============================================================
     * 2. UTILIDADES
     * ============================================================ */
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmtTime = sec => {
        sec = Math.max(0, Math.round(sec));
        const m = Math.floor(sec / 60), s = sec % 60;
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };
    const fmtDate = ts => new Date(ts).toLocaleString('es-CO');
    const clamp = (v, min, max, def) => {
        v = parseInt(v, 10);
        if (isNaN(v)) return def;
        return Math.min(max, Math.max(min, v));
    };
    const $ = (sel, ctx) => (ctx || document).querySelector(sel);

    /* ============================================================
     * 3. ESTILOS (misma apariencia del panel de referencia)
     * ============================================================ */
    GM_addStyle(`
    #${ROOT_ID}{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;line-height:1.4;}
    #${ROOT_ID}, #${ROOT_ID} *{box-sizing:border-box;}
    #${ROOT_ID}[data-theme=light]{
        --sps-panel:#f0f4f9; --sps-card:#ffffff; --sps-text:#697e91; --sps-title:#566a7c;
        --sps-border:#d4d8e9; --sps-border-soft:#c9c6c696; --sps-input:#ffffff; --sps-input-border:#ced4da;
        --sps-teal:#009688; --sps-teal-bg:#E0F2F1; --sps-accent:#7986cb; --sps-accent-bg:#e8eaf6;
        --sps-shadow:0px 0px 0px 4px #ffffff; --sps-side-active:#eceff1c7; --sps-side-text:gray;
        --sps-btn-bg:#ffffff; --sps-btn-text:#606266; --sps-btn-border:#dcdfe6; --sps-chip:#f0f8ff; --sps-chip-border:#c5cae9;
    }
    #${ROOT_ID}[data-theme=dark]{
        --sps-panel:#22272e; --sps-card:#2d333b; --sps-text:#a0adb9; --sps-title:#cbd6e2;
        --sps-border:#48535F; --sps-border-soft:#404950; --sps-input:#22272e; --sps-input-border:#48535F;
        --sps-teal:#4db6ac; --sps-teal-bg:#1f3a38; --sps-accent:#9fa8da; --sps-accent-bg:#2f3550;
        --sps-shadow:0px 0px 0px 4px #2d333b; --sps-side-active:#22272e; --sps-side-text:#9AA4B1;
        --sps-btn-bg:#2d333b; --sps-btn-text:#9AA4B1; --sps-btn-border:#48535F; --sps-chip:#24292e; --sps-chip-border:#48535F;
    }

    #${ROOT_ID} .sps_btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;cursor:pointer;
        background-color:var(--sps-btn-bg);color:var(--sps-btn-text);width:auto;font-size:13px;font-family:inherit;
        border-radius:0.3rem;padding:4px 9px;margin:0;border:1px solid var(--sps-btn-border);line-height:1.4;}
    #${ROOT_ID} .sps_btn:hover{color:#409eff;border-color:#409eff;background-color:#f1f8ff;}
    #${ROOT_ID} .sps_btn[disabled]{cursor:not-allowed;color:rgb(168,171,178);border:1px solid #e4e7ed;}
    #${ROOT_ID} .sps_btn.primary{color:#ffffff;border:1px solid #409eff;background-color:#409eff;}
    #${ROOT_ID} .sps_btn.primary:hover{color:#ffffff;border:1px solid #79bbff;background-color:#79bbff;}
    #${ROOT_ID} .sps_btn.success{color:#4caf50;border:1px solid #C8E6C9;background-color:#f0f9eb;}
    #${ROOT_ID} .sps_btn.warning{color:#e6a23c;border:1px solid #f3d19e;background-color:#fdf6ec;}
    #${ROOT_ID} .sps_btn.error{color:#f56c6c;border:1px solid #fab6b6;background-color:#fef0f0;}
    #${ROOT_ID} .sps_btn.error:hover{color:#ffffff;background-color:#f56c6c;border-color:#f56c6c;}
    #${ROOT_ID} .sps_btn.enabled{color:#42A5F5;border:1px solid #90CAF9;background-color:#fafbff;}
    #${ROOT_ID} .sps_btn.active{animation:sps_ripple .5s ease-in-out;}
    @keyframes sps_ripple{0%{box-shadow:0 0 0 0 rgba(64,158,255,.5);}100%{box-shadow:0 0 0 10px rgba(64,158,255,0);}}

    #${ROOT_ID} .sps_widget{position:fixed;right:16px;bottom:16px;z-index:2147483640;display:flex;align-items:center;gap:6px;
        padding:6px;background:var(--sps-card);border:1px solid var(--sps-border);border-radius:8px;box-shadow:var(--sps-shadow);color:var(--sps-text);}
    #${ROOT_ID} .sps_widget .sps_timer{font-size:13px;padding:0 6px;font-variant-numeric:tabular-nums;color:var(--sps-text);white-space:nowrap;}
    #${ROOT_ID} .sps_widget .sps_timer.low{color:#e6a23c;font-weight:600;}
    #${ROOT_ID} .sps_widget .sps_dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#4caf50;margin-right:5px;}
    #${ROOT_ID} .sps_widget .sps_dot.test{background:#e6a23c;}

    #${ROOT_ID} .sps_backdrop{position:fixed;inset:0;z-index:2147483645;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;}

    #${ROOT_ID} .sps_menu{position:relative;box-shadow:var(--sps-shadow);width:640px;max-width:96vw;max-height:94vh;overflow:hidden;
        border-radius:6px;background-color:var(--sps-panel);border:1px solid var(--sps-border);color:var(--sps-text);padding:10px 20px 20px 10px;}
    #${ROOT_ID} .sps_menu h3{margin:10px 0;font-size:1.4em;font-weight:700;color:var(--sps-title);}
    #${ROOT_ID} .sps_menu h4{margin:15px 0 10px 0;font-weight:600;color:var(--sps-title);font-size:1.05em;}
    #${ROOT_ID} .sps_menu hr{border:none;height:1px;background-color:var(--sps-border);margin:10px 0;}
    #${ROOT_ID} .sps_badge{border-radius:4px;border:1px solid var(--sps-teal);color:var(--sps-teal);background-color:var(--sps-card);
        padding:.5px 4px;margin-left:5px;font-size:12px;font-weight:normal;}
    #${ROOT_ID} .sps_container{display:flex;}
    #${ROOT_ID} .sps_sidebar{flex:0 0 auto;min-width:130px;padding:6px 10px 6px 6px;margin:10px 0;border-right:1px solid var(--sps-border);}
    #${ROOT_ID} .sps_sidebar h3{margin-top:0;font-size:1.15em;}
    #${ROOT_ID} .sps_sidebar ul{list-style:none;margin:0;padding:0;}
    #${ROOT_ID} .sps_sidebar li{margin:5px 0;background-color:var(--sps-card);border:1px solid var(--sps-border);border-radius:4px;list-style:none;}
    #${ROOT_ID} .sps_sidebar li a{text-decoration:none;display:flex;width:100%;font-size:15px;color:var(--sps-side-text);background-color:var(--sps-card);
        letter-spacing:1px;padding:7px;border-radius:4px;align-items:center;cursor:pointer;}
    #${ROOT_ID} .sps_sidebar li a.active{background-color:var(--sps-side-active);color:var(--sps-teal);font-weight:600;}
    #${ROOT_ID} .sps_content{flex-grow:1;margin:10px 0 0 12px;padding-right:10px;max-height:min(580px,72vh);overflow-y:auto;min-width:0;width:430px;}
    #${ROOT_ID} .sps_page{display:none;}
    #${ROOT_ID} .sps_page.active{display:block;}
    #${ROOT_ID} .sps_content::-webkit-scrollbar{width:5px;height:7px;background-color:#aaa;}
    #${ROOT_ID} .sps_content::-webkit-scrollbar-thumb{background-clip:padding-box;background-color:#d7d9e4;}
    #${ROOT_ID} .sps_content::-webkit-scrollbar-track{background-color:#f1f1f1;}

    #${ROOT_ID} .sps_tool{position:absolute;width:20px;height:20px;top:3px;right:3px;}
    #${ROOT_ID} .sps_close{width:20px;height:20px;border-radius:50%;border:none;margin:0;padding:0;background-color:#ff000080;
        transition:.15s ease all;text-align:center;color:transparent;font-size:10px;font-weight:bolder;cursor:pointer;line-height:20px;}
    #${ROOT_ID} .sps_close:hover{color:#ffffff;background-color:#ff0000cc;box-shadow:0 5px 5px 0 #00000026;}
    #${ROOT_ID} .sps_close:active{color:#ffffffde;background-color:#ff000080;}

    #${ROOT_ID} .sps_list{display:flex;flex-wrap:wrap;align-items:center;padding:10px;margin:5px 0;background-color:var(--sps-card);
        border:1px solid #c9c6c642;border-bottom-color:var(--sps-border-soft);border-radius:8px;justify-content:space-between;gap:8px;color:var(--sps-text);}
    #${ROOT_ID} .sps_list label{font-size:15px;color:var(--sps-text);}
    #${ROOT_ID} .sps_list small{display:block;font-size:12px;opacity:.85;margin-top:2px;}
    #${ROOT_ID} .sps_list p{margin:0;}
    #${ROOT_ID} .sps_list.alert_danger{color:#F44336;background-color:#FFEBEE;border:1px solid #F44336;margin:10px 0;}
    #${ROOT_ID} .sps_list.alert_warn{color:#E65100;background-color:#FFF3E0;border:1px solid #FF9800;margin:10px 0;}
    #${ROOT_ID} .sps_list.alert_tip{color:#009688;background-color:#E0F2F1;border:1px solid #009688;margin:10px 0;}
    #${ROOT_ID} .sps_list.alert_info{color:#ffffff;background-color:#009688;margin:10px 0;box-shadow:rgba(0,0,0,.06) 0 2px 4px 0 inset;}
    #${ROOT_ID} .sps_list.alert_warn label,#${ROOT_ID} .sps_list.alert_danger label,#${ROOT_ID} .sps_list.alert_tip label,#${ROOT_ID} .sps_list.alert_info label{color:inherit;}

    #${ROOT_ID} .sps_menu select,#${ROOT_ID} .sps_menu input[type=number]{padding:5px 10px;margin:-5px 0;border-radius:6px;border:1px solid var(--sps-input-border);
        color:var(--sps-teal);background:var(--sps-input);font-size:15px;font-family:inherit;}
    #${ROOT_ID} .sps_menu select{appearance:none;-webkit-appearance:none;padding-right:14px;}
    #${ROOT_ID} .sps_menu input[type=number]{width:90px;margin:-5px 3px;}
    #${ROOT_ID} .sps_menu input[type=number]::-webkit-inner-spin-button,#${ROOT_ID} .sps_menu input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}
    #${ROOT_ID} .sps_menu select:focus-visible,#${ROOT_ID} .sps_menu input:focus-visible,#${ROOT_ID} .sps_menu textarea:focus-visible{outline:none;border-color:var(--sps-accent);}
    #${ROOT_ID} .sps_menu textarea{width:100%;min-height:110px;resize:vertical;padding:8px 10px;border-radius:6px;border:1px solid var(--sps-input-border);
        color:var(--sps-teal);background:var(--sps-input);font-size:14px;font-family:Consolas,monospace;}

    #${ROOT_ID} .sps_menu .sps_list input[type=checkbox]{margin:0;appearance:none;-webkit-appearance:none;width:40px;height:20px;border:1.5px solid #D7CCC8;
        padding:0;border-radius:20px;background:#efebe978;position:relative;cursor:pointer;flex:0 0 auto;}
    #${ROOT_ID} .sps_menu .sps_list input[type=checkbox]::before{content:"";width:17px;height:17px;background:#D7CCC8;border:1.5px solid #BCAAA4;border-radius:50%;
        position:absolute;top:0;left:0;transform:translate(2%,2%);transition:all .3s ease-in-out;}
    #${ROOT_ID} .sps_menu .sps_list input[type=checkbox]:checked{border:1.5px solid #C5CAE9;background:#E8EAF6;}
    #${ROOT_ID} .sps_menu .sps_list input[type=checkbox]:checked::before{background:#C5CAE9;border:1.5px solid #7986CB;transform:translate(122%,2%);}
    #${ROOT_ID} .sps_menu .sps_list input[type=checkbox]::after{content:"\\00d7";position:absolute;top:-1px;left:25px;color:#EA0707;font-size:14px;font-weight:bold;opacity:.85;}
    #${ROOT_ID} .sps_menu .sps_list input[type=checkbox]:checked::after{content:"\\2713";left:6px;top:0;color:#03A9F4;font-size:12px;}

    #${ROOT_ID} .sps_menu .sps_list button{cursor:pointer;color:#7986cb;background-color:#e8eaf6;border:1px solid #7986cb;border-radius:6px;
        min-width:100px;margin:-5px 2px;padding:5px 10px;font-family:inherit;font-size:14px;}
    #${ROOT_ID} .sps_menu .sps_list button:hover{color:#e8eaf6;background-color:#7986cb;}
    #${ROOT_ID} .sps_menu .sps_list button.danger{color:#f56c6c;background:#fef0f0;border-color:#fab6b6;}
    #${ROOT_ID} .sps_menu .sps_list button.danger:hover{color:#fff;background:#f56c6c;}

    #${ROOT_ID} .sps_log_item{flex-basis:100%;font-size:13px;padding:6px 8px;margin:4px 0;border-radius:6px;border:1px solid var(--sps-border);background:var(--sps-chip);color:var(--sps-text);}
    #${ROOT_ID} .sps_log_item b{color:var(--sps-title);}

    #${ROOT_ID} .sps_warn{width:440px;max-width:94vw;padding:20px 22px;border-radius:10px;background:var(--sps-panel);border:1px solid var(--sps-border);
        box-shadow:var(--sps-shadow);color:var(--sps-text);text-align:center;}
    #${ROOT_ID} .sps_warn h3{margin:0 0 8px 0;font-size:1.4em;color:#E65100;font-weight:700;}
    #${ROOT_ID} .sps_warn p{margin:6px 0;font-size:15px;}
    #${ROOT_ID} .sps_warn ul{text-align:left;margin:8px 0 14px 18px;padding:0;font-size:14px;}
    #${ROOT_ID} .sps_warn li{margin:4px 0;list-style:disc;}
    #${ROOT_ID} .sps_warn .sps_count{font-size:42px;font-weight:700;color:#f56c6c;font-variant-numeric:tabular-nums;margin:6px 0;}
    #${ROOT_ID} .sps_bar{height:6px;border-radius:6px;background:var(--sps-border);overflow:hidden;margin:10px 0 16px 0;}
    #${ROOT_ID} .sps_bar>div{height:100%;width:100%;background:linear-gradient(90deg,#FF9800,#f56c6c);transition:width 1s linear;}
    #${ROOT_ID} .sps_warn .sps_actions{display:flex;gap:10px;justify-content:center;}
    #${ROOT_ID} .sps_warn .sps_btn{padding:7px 16px;font-size:14px;}

    #${ROOT_ID} .sps_http{position:fixed;top:0;left:0;right:0;z-index:2147483644;display:flex;align-items:center;justify-content:center;gap:12px;
        padding:8px 14px;color:#E65100;background-color:#FFF3E0;border-bottom:1px solid #FF9800;font-size:14px;}
    #${ROOT_ID} .sps_http button{cursor:pointer;color:#E65100;background:transparent;border:1px solid #FF9800;border-radius:4px;padding:1px 8px;font-family:inherit;}

    #${ROOT_ID} .sps_toasts{position:fixed;right:16px;bottom:76px;z-index:2147483646;display:flex;flex-direction:column;gap:8px;max-width:340px;}
    #${ROOT_ID} .sps_toast{padding:10px 12px;border-radius:8px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.18);border:1px solid;}
    #${ROOT_ID} .sps_toast.tip{color:#009688;background:#E0F2F1;border-color:#009688;}
    #${ROOT_ID} .sps_toast.warn{color:#E65100;background:#FFF3E0;border-color:#FF9800;}
    #${ROOT_ID} .sps_toast.danger{color:#F44336;background:#FFEBEE;border-color:#F44336;}
    #${ROOT_ID} .sps_toast.info{color:#ffffff;background:#009688;border-color:#00796B;}

    #${ROOT_ID} .sps_hl{position:absolute;z-index:2147483642;pointer-events:none;border:2px dashed #03A9F4;border-radius:4px;
        background:repeating-linear-gradient(135deg,rgb(77 208 225 / 30%),rgb(77 208 225 / 30%) 30px,rgb(77 208 225 / 10%) 0px,rgb(77 208 225 / 10%) 55px);}
    #${ROOT_ID} .sps_hl span{position:absolute;top:100%;left:0;margin-top:2px;font-size:12px;font-weight:bold;color:#00695C;background:#fff;border-radius:3px;padding:0 4px;white-space:nowrap;}
    `);

    /* ============================================================
     * 4. ESTADO
     * ============================================================ */
    let root = null;
    let state = 'active';            // active | warning
    let lastActivity = Date.now();
    let warnDeadline = 0;
    let warnEl = null;
    let panelEl = null;
    let widgetEl = null;
    let httpEl = null;
    let confirmEl = null;
    let cleaning = false;
    let lastRemind = Date.now();
    let tickId = null;
    let mqDark = null;

    /* ============================================================
     * 5. UI BASE
     * ============================================================ */
    function ensureRoot() {
        if (root && document.documentElement.contains(root)) return root;
        root = document.getElementById(ROOT_ID);
        if (!root) {
            root = document.createElement('div');
            root.id = ROOT_ID;
            (document.body || document.documentElement).appendChild(root);
        }
        applyTheme();
        return root;
    }

    function applyTheme() {
        if (!root) return;
        let t = cfg.theme;
        if (t === 'auto') t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
        root.setAttribute('data-theme', t);
    }

    function toast(msg, type, ms) {
        ensureRoot();
        let box = $('.sps_toasts', root);
        if (!box) {
            box = document.createElement('div');
            box.className = 'sps_toasts';
            root.appendChild(box);
        }
        const el = document.createElement('div');
        el.className = 'sps_toast ' + (type || 'tip');
        el.textContent = msg;
        box.appendChild(el);
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, ms || 5000);
    }

    /* ============================================================
     * 6. ACTIVIDAD E INACTIVIDAD
     * ============================================================ */
    function resetActivity() {
        lastActivity = Date.now();
        if (state === 'active') updateWidgetTimer(cfg.inactivitySec);
    }

    function onActivity() {
        if (state !== 'active') return;
        lastActivity = Date.now();
    }

    function bindActivity() {
        ['mousemove', 'mousedown', 'click', 'keydown', 'scroll', 'wheel', 'touchstart'].forEach(function (evt) {
            window.addEventListener(evt, onActivity, { capture: true, passive: true });
        });
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) tick();
        });
    }

    function tick() {
        if (!root || !document.documentElement.contains(root)) {
            root = null;
            ensureRoot();
            renderWidget();
            renderHttpBanner();
        }
        const now = Date.now();
        if (state === 'active' && cfg.remindMinutes > 0 && now - lastRemind > cfg.remindMinutes * 60000) {
            lastRemind = now;
            toast('Recuerda cerrar tu sesión al terminar. Usa el botón «Limpiar sesión».', 'warn', 9000);
        }
        if (state === 'active') {
            const left = cfg.inactivitySec - (now - lastActivity) / 1000;
            if (left <= 0) showWarning();
            else updateWidgetTimer(left);
        } else if (state === 'warning') {
            const left = Math.ceil((warnDeadline - now) / 1000);
            if (left <= 0) {
                hideWarning();
                state = 'active';
                cleanSession('inactividad');
                resetActivity();
            } else {
                updateWarning(left);
            }
        }
    }

    /* ============================================================
     * 7. WIDGET FLOTANTE
     * ============================================================ */
    function renderWidget() {
        ensureRoot();
        if (widgetEl && widgetEl.parentNode) widgetEl.parentNode.removeChild(widgetEl);
        widgetEl = null;
        if (!cfg.showWidget) return;
        widgetEl = document.createElement('div');
        widgetEl.className = 'sps_widget';
        widgetEl.innerHTML =
            '<span class="sps_timer" title="Tiempo restante de inactividad"><span class="sps_dot' + (cfg.testMode ? ' test' : '') + '"></span><span class="sps_time">--:--</span></span>' +
            '<button type="button" class="sps_btn error" data-act="clean" title="Cerrar sesión y limpiar">Limpiar sesión</button>' +
            '<button type="button" class="sps_btn" data-act="open-panel" title="Configuración">&#9881;</button>';
        widgetEl.addEventListener('click', function (e) {
            const b = e.target.closest('button[data-act]');
            if (!b) return;
            b.classList.add('active');
            setTimeout(function () { b.classList.remove('active'); }, 500);
            if (b.dataset.act === 'clean') confirmClean('manual');
            if (b.dataset.act === 'open-panel') openPanel();
        });
        root.appendChild(widgetEl);
        updateWidgetTimer(cfg.inactivitySec);
    }

    function updateWidgetTimer(left) {
        if (!widgetEl) return;
        const t = $('.sps_time', widgetEl);
        const w = $('.sps_timer', widgetEl);
        if (t) t.textContent = fmtTime(left);
        if (w) w.classList.toggle('low', left <= 30);
    }

    /* ============================================================
     * 8. ADVERTENCIA VISUAL
     * ============================================================ */
    function showWarning() {
        if (state === 'warning') return;
        ensureRoot();
        state = 'warning';
        warnDeadline = Date.now() + cfg.warningSec * 1000;
        warnEl = document.createElement('div');
        warnEl.className = 'sps_backdrop';
        warnEl.style.zIndex = '2147483647';
        warnEl.innerHTML =
            '<div class="sps_warn" role="alertdialog" aria-live="assertive">' +
            '<h3>&#9888; ¿Sigues ahí?</h3>' +
            '<p>Por seguridad, la sesión se cerrará y se limpiará por inactividad en:</p>' +
            '<div class="sps_count">' + fmtTime(cfg.warningSec) + '</div>' +
            '<div class="sps_bar"><div></div></div>' +
            (cfg.testMode ? '<p style="font-size:13px;color:#e6a23c">Modo de prueba activo: no se cerrará ninguna sesión real.</p>' : '') +
            '<div class="sps_actions">' +
            '<button type="button" class="sps_btn primary" data-act="stay">Seguir en sesión</button>' +
            '<button type="button" class="sps_btn error" data-act="now">Limpiar ahora</button>' +
            '</div></div>';
        warnEl.addEventListener('click', function (e) {
            const b = e.target.closest('button[data-act]');
            if (!b) return;
            hideWarning();
            state = 'active';
            if (b.dataset.act === 'now') cleanSession('manual (advertencia)');
            resetActivity();
        });
        root.appendChild(warnEl);
        const btn = $('button[data-act=stay]', warnEl);
        if (btn) btn.focus();
    }

    function updateWarning(left) {
        if (!warnEl) return;
        const c = $('.sps_count', warnEl);
        const bar = $('.sps_bar>div', warnEl);
        if (c) c.textContent = fmtTime(left);
        if (bar) bar.style.width = Math.max(0, Math.min(100, (left / cfg.warningSec) * 100)) + '%';
    }

    function hideWarning() {
        if (warnEl && warnEl.parentNode) warnEl.parentNode.removeChild(warnEl);
        warnEl = null;
    }

    /* ============================================================
     * 9. ALERTA HTTP
     * ============================================================ */
    function isInsecure() {
        const h = location.hostname;
        const local = h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
        return location.protocol === 'http:' && !local;
    }

    function renderHttpBanner() {
        ensureRoot();
        if (httpEl && httpEl.parentNode) httpEl.parentNode.removeChild(httpEl);
        httpEl = null;
        if (!cfg.warnHttp || !isInsecure()) return;
        httpEl = document.createElement('div');
        httpEl.className = 'sps_http';
        httpEl.innerHTML =
            '<span>&#9888; <b>Conexión no segura (HTTP).</b> Lo que escribas en esta página puede ser interceptado. No ingreses contraseñas ni datos personales.</span>' +
            '<button type="button" data-act="hide-http">Entendido</button>';
        httpEl.addEventListener('click', function (e) {
            if (e.target.closest('[data-act=hide-http]') && httpEl.parentNode) httpEl.parentNode.removeChild(httpEl);
        });
        root.appendChild(httpEl);
    }

    /* ============================================================
     * 10. DETECCIÓN DE BOTONES DE CIERRE DE SESIÓN
     * ============================================================ */
    const LOGOUT_TEXT = /^(?:.{0,12}\s)?(cerrar(?:\s+la)?\s+sesi[oó]n|finalizar\s+sesi[oó]n|terminar\s+sesi[oó]n|salir|desconectar(?:se)?|log\s?-?out|sign\s?-?out|log\s?off|logoff)(?:\s.{0,12})?$/i;
    const LOGOUT_HREF = /(log-?out|sign-?out|log-?off|cerrar[-_]?sesion|cerrarsesion|desconectar)/i;
    const LOGOUT_ATTR = /(log-?out|sign-?out|log-?off|cerrar[-_]?sesion|cerrarsesion)/i;

    function elText(el) {
        return (el.innerText || el.textContent || el.value || '').trim().replace(/\s+/g, ' ');
    }

    function isVisible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const cs = window.getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
    }

    function findLogoutCandidates() {
        const nodes = document.querySelectorAll('a, button, input[type=submit], input[type=button], [role=button], [role=menuitem], [role=link]');
        const found = [];
        nodes.forEach(function (el) {
            if (root && root.contains(el)) return;
            let score = 0;
            const text = elText(el);
            const aria = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
            const href = el.tagName === 'A' ? (el.getAttribute('href') || '') : '';
            const form = el.closest ? el.closest('form') : null;
            const action = form ? (form.getAttribute('action') || '') : '';
            const attrs = [el.id, el.getAttribute('name'), el.getAttribute('data-testid'), el.getAttribute('data-action'), typeof el.className === 'string' ? el.className : ''].join(' ');
            if (text && text.length <= 40 && LOGOUT_TEXT.test(text)) score += 3;
            if (aria.trim() && aria.length <= 60 && LOGOUT_TEXT.test(aria.trim())) score += 2;
            if (href && !/^javascript:/i.test(href) && LOGOUT_HREF.test(href)) score += 3;
            if (action && /\/logout\/?$/i.test(action.split('?')[0])) score += 4;
            if (LOGOUT_ATTR.test(attrs)) score += 2;
            if (score > 0) {
                const vis = isVisible(el);
                found.push({ el: el, score: score + (vis ? 1 : 0), visible: vis, label: text || aria.trim() || href || el.id || el.tagName });
            }
        });
        found.sort(function (a, b) { return b.score - a.score; });
        return found;
    }

    function highlight(el, label) {
        ensureRoot();
        try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* ignorar */ }
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const hl = document.createElement('div');
        hl.className = 'sps_hl';
        hl.style.left = (r.left + window.scrollX - 3) + 'px';
        hl.style.top = (r.top + window.scrollY - 3) + 'px';
        hl.style.width = (r.width + 6) + 'px';
        hl.style.height = (r.height + 6) + 'px';
        hl.innerHTML = '<span>' + esc(label || 'Botón de cierre de sesión') + '</span>';
        root.appendChild(hl);
        setTimeout(function () { if (hl.parentNode) hl.parentNode.removeChild(hl); }, 4500);
        return true;
    }

    /* ============================================================
     * 11. LIMPIEZA
     * ============================================================ */
    const TEXT_TYPES = ['', 'text', 'email', 'search', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'week', 'time'];
    const TOKEN_RE = /(token|otp|2fa|mfa|secret|c[oó]digo|codigo|verification|passcode|\bpin\b)/i;
    const CSRF_RE = /(csrf|xsrf|authenticity|viewstate|eventvalidation|nonce|sesskey|requestverification)/i;

    function setNative(el, val) {
        try {
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const d = Object.getOwnPropertyDescriptor(proto, 'value');
            if (d && d.set) d.set.call(el, val); else el.value = val;
        } catch (e) { el.value = val; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function clearFieldsIn(doc, counts) {
        doc.querySelectorAll('input, textarea').forEach(function (el) {
            if (root && root.contains(el)) return;
            if (el.disabled || el.readOnly) return;
            const type = (el.getAttribute('type') || '').toLowerCase();
            const ident = [el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' ');
            const isTextarea = el.tagName === 'TEXTAREA';
            let kind = null;

            if (type === 'password') kind = cfg.clearPasswords ? 'passwords' : null;
            else if (type === 'hidden') {
                if (cfg.clearTokens && TOKEN_RE.test(ident) && !CSRF_RE.test(ident)) kind = 'tokens';
            } else if (!isTextarea && TOKEN_RE.test(ident) && TEXT_TYPES.indexOf(type) !== -1) {
                kind = cfg.clearTokens ? 'tokens' : null;
            } else if (isTextarea || TEXT_TYPES.indexOf(type) !== -1) {
                kind = cfg.clearForms ? 'forms' : null;
            }

            if (kind && el.value !== '') {
                setNative(el, '');
                counts[kind]++;
            }
        });

        if (cfg.clearForms) {
            doc.querySelectorAll('[contenteditable=""], [contenteditable="true"]').forEach(function (el) {
                if (root && root.contains(el)) return;
                if (el.textContent && el.textContent.trim() !== '') {
                    el.textContent = '';
                    counts.forms++;
                }
            });
        }
    }

    function clearSensitiveFields() {
        const counts = { passwords: 0, tokens: 0, forms: 0 };
        clearFieldsIn(document, counts);
        document.querySelectorAll('iframe').forEach(function (fr) {
            try { if (fr.contentDocument) clearFieldsIn(fr.contentDocument, counts); } catch (e) { /* otro origen */ }
        });
        return counts;
    }

    function wipeCookies() {
        let n = 0;
        const parts = location.hostname.split('.');
        const domains = [location.hostname];
        for (let i = 1; i < parts.length - 1; i++) domains.push('.' + parts.slice(i).join('.'));
        document.cookie.split(';').forEach(function (c) {
            const name = c.split('=')[0].trim();
            if (!name) return;
            if (/csrf/i.test(name)) return;   // se necesita para que el cierre de sesión funcione
            domains.concat([undefined]).forEach(function (d) {
                document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + (d ? '; domain=' + d : '');
            });
            n++;
        });
        return n;
    }

    function wipeStorages() {
        const out = { session: false, local: false, cookies: 0 };
        try { if (cfg.wipeSession) { window.sessionStorage.clear(); out.session = true; } } catch (e) { /* ignorar */ }
        try { if (cfg.wipeLocal) { window.localStorage.clear(); out.local = true; } } catch (e) { /* ignorar */ }
        try { if (cfg.wipeCookies) out.cookies = wipeCookies(); } catch (e) { /* ignorar */ }
        return out;
    }

    function getLog() {
        let l = [];
        try { l = GM_getValue('cleanupLog', []) || []; } catch (e) { l = []; }
        return Array.isArray(l) ? l : [];
    }

    function writeLog(entry) {
        const log = getLog();
        log.unshift(entry);
        try {
            GM_setValue('cleanupLog', log.slice(0, MAX_LOG));
            GM_setValue('lastCleanup', entry);
        } catch (e) { console.warn('[SesiónSegura] No se pudo registrar', e); }
    }

    function markPendingWipe() {
        try { GM_setValue('pendingWipe', { ts: Date.now(), host: location.hostname }); } catch (e) { /* ignorar */ }
    }

    function submitLogoutForm(dry, done) {
        const m = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/);
        if (!isCanvas() || !m) { done({ found: false, text: 'no se encontró botón de cierre' }); return; }
        done({ found: true, text: (dry ? 'detectado (simulado): ' : '') + 'envío directo a /logout' });
        if (dry) return;
        markPendingWipe();
        setTimeout(function () {
            const f = document.createElement('form');
            f.method = 'POST';
            f.action = '/logout';
            f.style.display = 'none';
            [['_method', 'delete'], ['authenticity_token', decodeURIComponent(m[1])]].forEach(function (p) {
                const i = document.createElement('input');
                i.type = 'hidden'; i.name = p[0]; i.value = p[1];
                f.appendChild(i);
            });
            document.body.appendChild(f);
            f.submit();
        }, 400);
    }

    function runLogout(dry, done) {
        function act(c) {
            if (dry) {
                highlight(c.el, 'Cierre detectado (prueba)');
                done({ found: true, text: 'detectado (simulado): ' + c.label });
                return;
            }
            done({ found: true, text: 'clic en: ' + c.label });
            markPendingWipe();
            setTimeout(function () {
                try { c.el.click(); } catch (e) { toast('No se pudo pulsar el botón de cierre.', 'danger'); }
            }, 400);
        }
        const cands = findLogoutCandidates();
        if (cands.length) { act(cands[0]); return; }

        // Canvas: el botón "Cerrar sesión" está dentro de la bandeja de "Cuenta"
        const prof = isCanvas() ? document.getElementById('global_nav_profile_link') : null;
        if (prof) {
            try { prof.click(); } catch (e) { /* ignorar */ }
            let tries = 0;
            const iv = setInterval(function () {
                const c = findLogoutCandidates();
                if (c.length) { clearInterval(iv); act(c[0]); }
                else if (++tries >= 20) { clearInterval(iv); submitLogoutForm(dry, done); }
            }, 200);
            return;
        }
        if (isCanvas()) { submitLogoutForm(dry, done); return; }
        done({ found: false, text: 'no se encontró botón de cierre' });
    }

    function cleanSession(reason) {
        if (cleaning) return;
        cleaning = true;
        setTimeout(function () { cleaning = false; }, 6000);
        ensureRoot();
        const entry = {
            ts: Date.now(),
            host: location.hostname,
            reason: reason || 'manual',
            test: !!cfg.testMode,
            fields: { passwords: 0, tokens: 0, forms: 0 },
            storage: { session: false, local: false, cookies: 0 },
            logout: 'no solicitado'
        };

        try { entry.fields = clearSensitiveFields(); } catch (e) { console.error('[SesiónSegura]', e); }
        if (!cfg.testMode) {
            try { entry.storage = wipeStorages(); } catch (e) { console.error('[SesiónSegura]', e); }
        }

        function finish(res) {
            if (res) entry.logout = res.text;
            writeLog(entry);
            refreshLogPage();
            const total = entry.fields.passwords + entry.fields.tokens + entry.fields.forms;
            let msg = 'Limpieza completada: ' + total + ' campo(s) borrado(s).';
            if (cfg.testMode) msg += ' [Modo de prueba]';
            else if (res && res.found) msg += ' Cerrando sesión…';
            if (res && !res.found) msg += ' No se encontró botón de cierre: cierra la sesión manualmente.';
            toast(msg, res && !res.found ? 'warn' : 'tip', 6500);
        }

        if (cfg.tryLogout) runLogout(!!cfg.testMode, finish);
        else finish(null);
    }

    function confirmClean(reason) {
        if (cfg.testMode) { cleanSession(reason); return; }
        ensureRoot();
        if (confirmEl) return;
        confirmEl = document.createElement('div');
        confirmEl.className = 'sps_backdrop';
        confirmEl.style.zIndex = '2147483647';
        confirmEl.innerHTML =
            '<div class="sps_warn" role="alertdialog">' +
            '<h3>Cerrar sesión y limpiar</h3>' +
            '<p>Se hará lo siguiente en <b>' + esc(location.hostname) + '</b>:</p>' +
            '<ul><li>Borrar contraseñas, códigos y texto de formularios.</li>' +
            '<li>Vaciar datos locales de esta página.</li>' +
            '<li>Cerrar tu sesión.</li></ul>' +
            '<p style="font-size:13px">Guarda tu trabajo antes de continuar.</p>' +
            '<div class="sps_actions"><button type="button" class="sps_btn" data-act="no">Cancelar</button>' +
            '<button type="button" class="sps_btn error" data-act="yes">Sí, limpiar</button></div></div>';
        confirmEl.addEventListener('click', function (e) {
            const b = e.target.closest('button[data-act]');
            if (!b) return;
            if (confirmEl.parentNode) confirmEl.parentNode.removeChild(confirmEl);
            confirmEl = null;
            if (b.dataset.act === 'yes') cleanSession(reason);
        });
        root.appendChild(confirmEl);
    }

    function showReminder() {
        ensureRoot();
        const el = document.createElement('div');
        el.className = 'sps_backdrop';
        el.innerHTML =
            '<div class="sps_warn" role="dialog" aria-label="Recordatorio de seguridad">' +
            '<h3 style="color:#009688">&#128274; Recordatorio de seguridad</h3>' +
            '<p>Estás en <b>' + esc(location.hostname) + '</b>. Si este computador es compartido, al terminar:</p>' +
            '<ul><li>Pulsa <b>Limpiar sesión</b> (abajo a la derecha) para cerrar tu sesión.</li>' +
            '<li>Cierra también tu cuenta de correo o de inicio de sesión institucional si la usaste.</li>' +
            '<li>Cierra todas las pestañas y el navegador.</li></ul>' +
            (isInsecure() ? '<p style="color:#E65100">&#9888; Esta conexión no es segura (HTTP).</p>' : '') +
            '<div class="sps_actions"><button type="button" class="sps_btn primary" data-act="ok">Entendido</button></div></div>';
        el.addEventListener('click', function (e) {
            if (e.target.closest('[data-act=ok]') && el.parentNode) { el.parentNode.removeChild(el); resetActivity(); }
        });
        root.appendChild(el);
    }

    function maybeReminder() {
        if (!cfg.remindOnLoad) return;
        let done = false;
        try { done = window.sessionStorage.getItem('sps_reminded') === '1'; window.sessionStorage.setItem('sps_reminded', '1'); } catch (e) { /* ignorar */ }
        if (!done) setTimeout(showReminder, 700);
    }

    function pendingWipeCheck() {
        let p = null;
        try { p = GM_getValue('pendingWipe', null); } catch (e) { p = null; }
        if (!p) return;
        try { GM_deleteValue('pendingWipe'); } catch (e) { /* ignorar */ }
        if (p.host !== location.hostname || Date.now() - p.ts > 120000) return;
        try { wipeStorages(); } catch (e) { /* ignorar */ }
        toast('Limpieza posterior al cierre de sesión completada.', 'tip', 6000);
    }

    /* ============================================================
     * 12. PANEL DE CONFIGURACIÓN
     * ============================================================ */
    function sw(key, label, hint) {
        return '<div class="sps_list"><div><label for="sps_' + key + '">' + label + '</label>' +
            (hint ? '<small>' + hint + '</small>' : '') + '</div>' +
            '<input type="checkbox" id="sps_' + key + '" data-key="' + key + '"' + (cfg[key] ? ' checked' : '') + '></div>';
    }

    function logPageHtml() {
        const log = getLog();
        if (!log.length) return '<div class="sps_list alert_tip"><p>Aún no se ha realizado ninguna limpieza.</p></div>';
        return log.map(function (e, i) {
            const f = e.fields || {};
            return '<div class="sps_log_item">' + (i === 0 ? '<span class="sps_badge">última</span> ' : '') +
                '<b>' + esc(fmtDate(e.ts)) + '</b> &middot; ' + esc(e.host) + '<br>' +
                'Motivo: ' + esc(e.reason) + (e.test ? ' (prueba)' : '') + '<br>' +
                'Contraseñas: ' + (f.passwords || 0) + ' &middot; Tokens: ' + (f.tokens || 0) + ' &middot; Formularios: ' + (f.forms || 0) + '<br>' +
                'Cierre de sesión: ' + esc(e.logout) + '</div>';
        }).join('');
    }

    function refreshLogPage() {
        if (!panelEl) return;
        const box = $('#sps_logbox', panelEl);
        if (box) box.innerHTML = logPageHtml();
    }

    function panelHtml() {
        const host = esc(location.hostname);
        return '' +
        '<div class="sps_menu" role="dialog" aria-label="Configuración de Sesión Segura">' +
          '<div class="sps_tool"><button type="button" class="sps_close" data-act="close-panel" title="Cerrar">&#10005;</button></div>' +
          '<div class="sps_container">' +
            '<div class="sps_sidebar"><h3>Sesión Segura<span class="sps_badge">v' + VERSION + '</span></h3><hr><ul>' +
              '<li><a data-page="general" class="active">General</a></li>' +
              '<li><a data-page="limpieza">Limpieza</a></li>' +
              '<li><a data-page="dominios">Dominios</a></li>' +
              '<li><a data-page="registro">Registro</a></li>' +
              '<li><a data-page="acerca">Acerca de</a></li>' +
            '</ul></div>' +
            '<div class="sps_content">' +

              '<div class="sps_page active" data-pg="general">' +
                '<h3>General</h3>' +
                '<div class="sps_list alert_warn"><p>El <b>modo de prueba</b> evita cerrar sesiones reales: solo detecta y resalta el botón de cierre.</p></div>' +
                sw('testMode', 'Modo de prueba', 'Recomendado durante la demostración') +
                sw('showWidget', 'Mostrar botón flotante', 'Contador y botón “Limpiar sesión”') +
                '<div class="sps_list"><label for="sps_inactivitySec">Inactividad (segundos)</label><input type="number" id="sps_inactivitySec" data-key="inactivitySec" min="10" max="86400" value="' + cfg.inactivitySec + '"></div>' +
                '<div class="sps_list"><label for="sps_warningSec">Advertencia previa (segundos)</label><input type="number" id="sps_warningSec" data-key="warningSec" min="5" max="600" value="' + cfg.warningSec + '"></div>' +
                sw('warnHttp', 'Alertar si la página usa HTTP', 'Muestra un aviso en sitios sin HTTPS') +
                sw('remindOnLoad', 'Recordatorio al entrar', 'Aviso para cerrar sesión (una vez por pestaña)') +
                '<div class="sps_list"><div><label for="sps_remindMinutes">Recordatorio periódico (minutos)</label><small>0 = desactivado</small></div><input type="number" id="sps_remindMinutes" data-key="remindMinutes" min="0" max="240" value="' + cfg.remindMinutes + '"></div>' +
                '<div class="sps_list"><label for="sps_theme">Tema</label><select id="sps_theme" data-key="theme">' +
                  '<option value="auto"' + (cfg.theme === 'auto' ? ' selected' : '') + '>Automático</option>' +
                  '<option value="light"' + (cfg.theme === 'light' ? ' selected' : '') + '>Claro</option>' +
                  '<option value="dark"' + (cfg.theme === 'dark' ? ' selected' : '') + '>Oscuro</option></select></div>' +
                '<div class="sps_list"><label>Restablecer configuración</label><button type="button" class="danger" data-act="reset">Restablecer</button></div>' +
              '</div>' +

              '<div class="sps_page" data-pg="limpieza">' +
                '<h3>Limpieza</h3>' +
                sw('clearPasswords', 'Borrar campos de contraseña') +
                sw('clearTokens', 'Borrar tokens y códigos', 'OTP, códigos de verificación, PIN (se respetan los tokens CSRF)') +
                sw('clearForms', 'Borrar formularios sensibles', 'Texto escrito en inputs, textarea y editores') +
                sw('tryLogout', 'Cierre de sesión asistido', 'Busca y pulsa el botón de cerrar sesión (en Canvas abre el menú Cuenta)') +
                '<h4>Datos del navegador (solo fuera del modo de prueba)</h4>' +
                sw('wipeSession', 'Vaciar sessionStorage') +
                sw('wipeLocal', 'Vaciar localStorage', 'Borra borradores y preferencias guardadas por la página') +
                sw('wipeCookies', 'Borrar cookies accesibles', 'Las cookies HttpOnly no pueden borrarse desde un userscript') +
                '<div class="sps_list"><label>Detectar botón de cierre</label><button type="button" data-act="detect">Detectar</button></div>' +
                '<div class="sps_list"><label>Ejecutar limpieza ahora</label><button type="button" class="danger" data-act="clean">Limpiar sesión</button></div>' +
              '</div>' +

              '<div class="sps_page" data-pg="dominios">' +
                '<h3>Dominios autorizados</h3>' +
                '<div class="sps_list alert_tip"><p>Un dominio por línea. El script solo actúa en estos dominios (incluye sus subdominios). Además, Tampermonkey debe tener la regla <code>@match</code> correspondiente en la cabecera.</p></div>' +
                '<div class="sps_list"><textarea id="sps_domains" data-key="domains" spellcheck="false">' + esc(cfg.domains.join('\n')) + '</textarea></div>' +
                '<div class="sps_list"><label>Dominio actual: <b>' + host + '</b></label><button type="button" data-act="add-domain">Agregar</button></div>' +
              '</div>' +

              '<div class="sps_page" data-pg="registro">' +
                '<h3>Registro local</h3>' +
                '<div id="sps_logbox">' + logPageHtml() + '</div>' +
                '<div class="sps_list"><label>Borrar el registro</label><button type="button" class="danger" data-act="clear-log">Borrar</button></div>' +
              '</div>' +

              '<div class="sps_page" data-pg="acerca">' +
                '<h3>Acerca de y límites</h3>' +
                '<div class="sps_list alert_info"><p>Sesión Segura v' + VERSION + ' &middot; Proyecto de Gestión de Proyectos ICD, Politécnico Grancolombiano.</p></div>' +
                '<div class="sps_list alert_warn"><p><b>Limitaciones:</b> no reemplaza los mecanismos de seguridad del navegador ni garantiza cerrar todas las sesiones. No puede borrar cookies HttpOnly, caché ni historial, ni cerrar sesión en portales sin un botón detectable. Cerrar Canvas no cierra la sesión del proveedor de identidad (por ejemplo Microsoft o Google) si el ingreso fue por SSO.</p></div>' +
                '<div class="sps_list"><p>Acciones manuales pendientes: cerrar la cuenta en cada servicio, cerrar las pestañas y borrar cookies, caché y datos de formularios desde el navegador (por ejemplo con Ctrl+Shift+Supr) o usar una ventana privada.</p></div>' +
              '</div>' +

            '</div>' +
          '</div>' +
        '</div>';
    }

    function openPanel() {
        ensureRoot();
        if (panelEl) return;
        panelEl = document.createElement('div');
        panelEl.className = 'sps_backdrop';
        panelEl.innerHTML = panelHtml();
        panelEl.addEventListener('mousedown', function (e) {
            if (e.target === panelEl) closePanel();
        });
        panelEl.addEventListener('click', onPanelClick);
        panelEl.addEventListener('change', onPanelChange);
        root.appendChild(panelEl);
    }

    function closePanel() {
        if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
        panelEl = null;
        resetActivity();
    }

    function gotoPage(name) {
        panelEl.querySelectorAll('.sps_sidebar a').forEach(function (a) { a.classList.toggle('active', a.dataset.page === name); });
        panelEl.querySelectorAll('.sps_page').forEach(function (p) { p.classList.toggle('active', p.dataset.pg === name); });
        if (name === 'registro') refreshLogPage();
    }

    function onPanelClick(e) {
        const link = e.target.closest('.sps_sidebar a[data-page]');
        if (link) { gotoPage(link.dataset.page); return; }
        const b = e.target.closest('[data-act]');
        if (!b) return;
        switch (b.dataset.act) {
            case 'close-panel': closePanel(); break;
            case 'clean': confirmClean('manual (panel)'); break;
            case 'detect': {
                const c = findLogoutCandidates();
                if (!c.length) {
                    toast(isCanvas() ? 'No se ve el botón: en Canvas está dentro del menú «Cuenta». Se abrirá automáticamente al limpiar.' : 'No se encontró ningún botón de cierre de sesión en esta página.', 'warn', 7000);
                    break;
                }
                const ok = highlight(c[0].el, 'Cierre detectado');
                toast('Detectados ' + c.length + ' candidato(s). Mejor: “' + c[0].label + '”' + (ok ? '' : ' (oculto)'), 'tip');
                break;
            }
            case 'add-domain': {
                const d = normDomain(location.hostname);
                if (cfg.domains.map(normDomain).indexOf(d) === -1) cfg.domains.push(d);
                saveCfg();
                const ta = $('#sps_domains', panelEl);
                if (ta) ta.value = cfg.domains.join('\n');
                toast('Dominio agregado: ' + d, 'tip');
                break;
            }
            case 'clear-log':
                try { GM_deleteValue('cleanupLog'); GM_deleteValue('lastCleanup'); } catch (err) { /* ignorar */ }
                refreshLogPage();
                toast('Registro borrado.', 'tip');
                break;
            case 'reset':
                cfg = Object.assign({}, DEFAULTS, { domains: DEFAULTS.domains.slice() });
                saveCfg();
                applyAll();
                closePanel();
                openPanel();
                toast('Configuración restablecida.', 'tip');
                break;
        }
    }

    function onPanelChange(e) {
        const el = e.target;
        const key = el.dataset && el.dataset.key;
        if (!key) return;
        if (el.type === 'checkbox') cfg[key] = el.checked;
        else if (key === 'inactivitySec') { cfg.inactivitySec = clamp(el.value, 10, 86400, DEFAULTS.inactivitySec); el.value = cfg.inactivitySec; }
        else if (key === 'warningSec') { cfg.warningSec = clamp(el.value, 5, 600, DEFAULTS.warningSec); el.value = cfg.warningSec; }
        else if (key === 'remindMinutes') { cfg.remindMinutes = clamp(el.value, 0, 240, DEFAULTS.remindMinutes); el.value = cfg.remindMinutes; lastRemind = Date.now(); }
        else if (key === 'domains') {
            const list = el.value.split(/\r?\n/).map(normDomain).filter(Boolean);
            const cur = location.hostname.toLowerCase();
            const stays = list.some(function (d) { return cur === d || cur.endsWith('.' + d); });
            if (!stays) { toast('El dominio actual no puede quedar fuera de la lista mientras estás en él.', 'warn'); list.push(normDomain(cur)); }
            cfg.domains = Array.from(new Set(list));
            el.value = cfg.domains.join('\n');
        } else cfg[key] = el.value;
        saveCfg();
        applyAll();
    }

    function applyAll() {
        applyTheme();
        renderWidget();
        renderHttpBanner();
        if (panelEl && panelEl.parentNode) root.appendChild(panelEl);
        resetActivity();
    }

    /* ============================================================
     * 13. INICIO
     * ============================================================ */
    function init() {
        ensureRoot();
        applyTheme();
        if (window.matchMedia) {
            mqDark = window.matchMedia('(prefers-color-scheme: dark)');
            const h = function () { applyTheme(); };
            if (mqDark.addEventListener) mqDark.addEventListener('change', h);
            else if (mqDark.addListener) mqDark.addListener(h);
        }
        renderWidget();
        renderHttpBanner();
        bindActivity();
        resetActivity();
        tickId = setInterval(tick, 1000);
        pendingWipeCheck();
        maybeReminder();

        try {
            GM_registerMenuCommand('Abrir configuración', openPanel);
            GM_registerMenuCommand('Limpiar sesión ahora', function () { confirmClean('manual (menú)'); });
        } catch (e) { /* ignorar */ }

        console.log('[SesiónSegura] v' + VERSION + ' activo en ' + location.hostname + (cfg.testMode ? ' (modo de prueba)' : ''));
    }

    if (document.body) init();
    else document.addEventListener('DOMContentLoaded', init);
})();
