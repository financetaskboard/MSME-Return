/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         MSME PORTAL — Odoo Local Proxy Server  v3.0         ║
 * ║   Runs on http://localhost:3001                              ║
 * ║   Filter: x_msme_status = 'Yes' (Vendor Information tab)    ║
 * ║   Fields: x_msme_status, x_msme_type, x_msme_no             ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = 3001;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ── Settings ───────────────────────────────────────────────────
const SETTINGS_FILE = path.join(__dirname, 'odoo-settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {}
  return {};
}
function saveSettings(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

// ── Odoo Auth ──────────────────────────────────────────────────
async function odooAuthenticate(url, db, username, password) {
  const baseUrl = url.replace(/\/$/, '');
  const resp = await fetch(`${baseUrl}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: 1,
      params: { db, login: username, password }
    })
  });
  const data = await resp.json();
  if (!data.result || !data.result.uid || data.result.uid === false) {
    const msg = data.result?.message || data.error?.data?.message || 'Invalid credentials';
    throw new Error(`Authentication failed: ${msg}`);
  }
  return { uid: data.result.uid, cookie: resp.headers.get('set-cookie') || '', baseUrl };
}

// ── Odoo call_kw ───────────────────────────────────────────────
async function odooCall(session, model, method, args = [], kwargs = {}) {
  const resp = await fetch(`${session.baseUrl}/web/dataset/call_kw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session.cookie ? { Cookie: session.cookie } : {})
    },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: Math.floor(Math.random() * 99999),
      params: { model, method, args, kwargs: { context: { lang: 'en_IN' }, ...kwargs } }
    })
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.data?.message || data.error.message);
  return data.result;
}

// ── Detect MSME field names (probes your Odoo) ─────────────────
async function detectMsmeFields(session) {
  let allFields = {};
  try {
    allFields = await odooCall(session, 'res.partner', 'fields_get', [],
      { attributes: ['string', 'type'] });
  } catch (e) {
    console.warn('  ⚠ Could not fetch field list:', e.message);
    return { status: null, type: null, no: null };
  }

  const find = (candidates) => candidates.find(f => !!allFields[f]) || null;

  const F = {
    status: 'x_studio_msme_status',
    type:   'x_studio_msme_type',
    no:     'x_studio_msme_no'
  };
  console.log('  Fields: status=x_studio_msme_status | type=x_studio_msme_type | no=x_studio_msme_no');

  console.log('  Using: status=' + (F.status||'NOT FOUND') + ' | type=' + (F.type||'NOT FOUND') + ' | no=' + (F.no||'NOT FOUND'));
  return F;
}

// ── MSME Due Date = Invoice Date + 45 days (fixed, per 43B(h)) ─
function calcDueDate(billDateStr) {
  const d = new Date(billDateStr);
  d.setDate(d.getDate() + 45);
  return d;
}


function normalizeMsmeType(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('micro'))  return 'Micro';
  if (s.includes('small'))  return 'Small';
  if (s.includes('medium')) return 'Medium';
  return 'Micro'; // default
}

// ── GET /health ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'MSME Proxy v3', port: PORT, time: new Date().toISOString() });
});

// ── GET /api/settings ──────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const s = loadSettings();
  res.json({ ...s, apiKey: s.apiKey ? '••••••••' : '' });
});

// ── POST /api/settings ─────────────────────────────────────────
app.post('/api/settings', (req, res) => {
  try {
    const s = loadSettings();
    const incoming = req.body;
    if (incoming.apiKey === '••••••••') delete incoming.apiKey;
    saveSettings({ ...s, ...incoming });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/test ─────────────────────────────────────────────
app.post('/api/test', async (req, res) => {
  const s = { ...loadSettings(), ...req.body };
  if (req.body.apiKey === '••••••••') s.apiKey = loadSettings().apiKey;
  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);
    const F = await detectMsmeFields(session);

    let msmeCount = 0;
    if (F.status) {
      try {
        const ids = await odooCall(session, 'res.partner', 'search',
          [[['supplier_rank', '>', 0], [F.status, '=', 'Yes'], ['active', '=', true]]],
          { limit: 5000 }
        );
        msmeCount = Array.isArray(ids) ? ids.length : 0;
      } catch (e) { /* ignore */ }
    }

    res.json({
      ok: true,
      uid: session.uid,
      message: 'Connection successful!',
      fieldsFound: F,
      msmeVendorCount: msmeCount,
      note: F.status
        ? `✅ MSME fields found — ${msmeCount} MSME vendors (status=Yes)`
        : '⚠ MSME Status field not found — run /api/detect-fields to debug'
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── GET /api/debug/bill?name=BWB/2024/0555 — diagnose payment fetch for one bill ──
// Usage: open http://localhost:3001/api/debug/bill?name=BWB/2024/0555
app.get('/api/debug/bill', async (req, res) => {
  const s = loadSettings();
  const billName = req.query.name || '';
  if (!billName) return res.status(400).json({ error: 'Pass ?name=BWB/2024/0555' });
  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);

    // Find the bill
    const bills = await odooCall(session, 'account.move', 'search_read',
      [[['name', '=', billName], ['move_type', '=', 'in_invoice']]],
      { fields: ['id', 'name', 'partner_id', 'invoice_date', 'amount_total',
                 'amount_residual', 'payment_state', 'line_ids',
                 'invoice_payments_widget'], limit: 5 }
    );
    if (!bills.length) return res.status(404).json({ error: `Bill ${billName} not found` });
    const bill = bills[0];

    // Get all move lines
    const allLines = await odooCall(session, 'account.move.line', 'search_read',
      [[['move_id', '=', bill.id]]],
      { fields: ['id', 'account_id', 'account_type',
                 'debit', 'credit', 'name', 'reconciled'], limit: 100 }
    );

    // Get payable lines — Odoo 16/17 uses account_type = 'liability_payable'
    const payableLines = allLines.filter(l =>
      ['liability_payable', 'asset_receivable'].includes(l.account_type)
    );

    // Check reconciliations both ways
    const payableIds = payableLines.map(l => l.id);
    let recsCredit = [], recsDebit = [];
    if (payableIds.length) {
      recsCredit = await odooCall(session, 'account.partial.reconcile', 'search_read',
        [[['credit_move_id', 'in', payableIds]]],
        { fields: ['id','debit_move_id','credit_move_id','amount','create_date'], limit: 100 }
      );
      recsDebit = await odooCall(session, 'account.partial.reconcile', 'search_read',
        [[['debit_move_id', 'in', payableIds]]],
        { fields: ['id','debit_move_id','credit_move_id','amount','create_date'], limit: 100 }
      );
    }

    const widget = bill.invoice_payments_widget;

    res.json({
      bill: { id: bill.id, name: bill.name, partner: bill.partner_id?.[1],
              date: bill.invoice_date, amount: bill.amount_total,
              residual: bill.amount_residual, payment_state: bill.payment_state },
      allMoveLines: allLines.map(l => ({
        id: l.id, account: l.account_id?.[1], account_type: l.account_type,
        debit: l.debit, credit: l.credit, reconciled: l.reconciled
      })),
      payableLines: payableLines.map(l => ({ id: l.id, account: l.account_id?.[1], reconciled: l.reconciled })),
      reconciliations: {
        found_via_credit_side: recsCredit,
        found_via_debit_side: recsDebit,
        total: recsCredit.length + recsDebit.length
      },
      payments_widget: widget && widget !== false
        ? (typeof widget === 'string' ? JSON.parse(widget) : widget)
        : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/detect-fields — open in browser to see all x_ fields ──
app.get('/api/detect-fields', async (req, res) => {
  const s = loadSettings();
  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);
    const allFields = await odooCall(session, 'res.partner', 'fields_get', [],
      { attributes: ['string', 'type', 'selection'] });
    
    const msmeFields = Object.entries(allFields)
      .filter(([k]) => k.startsWith('x_') && (k.includes('msme') || k.includes('udyam')))
      .map(([k, v]) => ({ name: k, label: v.string, type: v.type }));
    
    const allCustom = Object.entries(allFields)
      .filter(([k]) => k.startsWith('x_'))
      .map(([k, v]) => ({ name: k, label: v.string, type: v.type }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Return HTML for easy reading
    const rows = msmeFields.map(f => 
      `<tr style="background:#e8f5e9"><td><b>${f.name}</b></td><td>${f.label}</td><td>${f.type}</td></tr>`
    ).join('') + allCustom.filter(f => !msmeFields.find(m => m.name === f.name)).map(f =>
      `<tr><td>${f.name}</td><td>${f.label}</td><td>${f.type}</td></tr>`
    ).join('');

    res.send(`<!DOCTYPE html><html><head><title>Odoo Fields</title>
    <style>body{font-family:Segoe UI,sans-serif;padding:20px}table{border-collapse:collapse;width:100%}
    th{background:#0078d4;color:#fff;padding:8px 12px;text-align:left}
    td{padding:6px 12px;border-bottom:1px solid #eee}tr:hover{background:#f5f5f5}
    .msme{background:#e8f5e9!important;font-weight:600}</style></head>
    <body><h2>Custom Fields on res.partner</h2>
    <p style="color:#107c10;font-weight:600">Green rows = MSME/Udyam fields (${msmeFields.length} found)</p>
    <table><tr><th>Field Name (technical)</th><th>Label (what you see in Odoo)</th><th>Type</th></tr>
    ${rows}</table></body></html>`);
  } catch (e) {
    res.status(400).send(`<h3 style="color:red">Error: ${e.message}</h3>`);
  }
});

// ── POST /api/sync/msme-vendors ───────────────────────────────
app.post('/api/sync/msme-vendors', async (req, res) => {
  const s = loadSettings();
  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);
    const F = await detectMsmeFields(session);

    if (!F.status) {
      return res.status(400).json({ ok: false,
        error: 'MSME Status field not found. POST to /api/detect-fields to list all custom fields.' });
    }

    const availExtra = await (async () => {
      try {
        const f = await odooCall(session, 'res.partner', 'fields_get', [], { attributes: ['string'] });
        return ['x_studio_gstin','x_gstin','x_gst_no','x_gstin_no'].filter(x => f[x]);
      } catch(e) { return []; }
    })();

    const fields = [
      'id', 'name', 'ref', 'vat', 'category_id', 'state_id',
      'phone', 'mobile', 'email', 'property_supplier_payment_term_id',
      F.status,
      ...(F.type ? [F.type] : []),
      ...(F.no   ? [F.no]   : []),
      ...availExtra
    ];

    const partners = await odooCall(session, 'res.partner', 'search_read',
      [[['supplier_rank', '>', 0], [F.status, '=', 'Yes'], ['active', '=', true]]],
      { fields, limit: 2000, order: 'name asc' }
    );

    const formatted = partners.map(p => {
      // vat field in Odoo holds GSTIN (e.g. 19ABQFA8686H1ZL) or PAN
      const rawVat = (p.vat || '').replace(/^IN/i, '');
      // Try dedicated GSTIN field first, else use vat
      const gstin = availExtra.reduce((g, f) => g || (p[f]||''), '') || rawVat;
      return {
        id:            p.id,
        vendor_name:   p.name,
        vendor_code:   p.ref || '',
        pan:           rawVat,   // portal will extract PAN from this if it's GSTIN
        gstin:         gstin,
        msme_status:   'Registered',
        msme_type:     F.type ? normalizeMsmeType(p[F.type]) : 'Micro',
        udyam_no:      F.no ? (p[F.no] || '') : '',
        state:         p.state_id ? p.state_id[1] : '',
        contact:       p.mobile || p.phone || '',
        email:         p.email  || '',
        payment_terms: p.property_supplier_payment_term_id
                       ? p.property_supplier_payment_term_id[1] : ''
      };
    });

    console.log(`✅ Fetched ${formatted.length} MSME vendors`);
    res.json({ ok: true, count: formatted.length, data: formatted, fieldsUsed: F });

  } catch (e) {
    console.error('❌ MSME vendors error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── POST /api/sync/vendor-master ──────────────────────────────
app.post('/api/sync/vendor-master', async (req, res) => {
  const s = loadSettings();
  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);
    const F = await detectMsmeFields(session);

    const fields = [
      'id', 'name', 'ref', 'vat', 'street', 'city',
      'state_id', 'country_id', 'phone', 'mobile', 'email',
      'category_id', 'property_supplier_payment_term_id',
      ...(F.status ? [F.status] : []),
      ...(F.type   ? [F.type]   : []),
      ...(F.no     ? [F.no]     : [])
    ];

    const partners = await odooCall(session, 'res.partner', 'search_read',
      [[['supplier_rank', '>', 0], ['active', '=', true]]],
      { fields, limit: 5000, order: 'name asc' }
    );

    const formatted = partners.map(p => {
      const isMsme  = F.status ? String(p[F.status] || '').toLowerCase() === 'yes' : false;
      const msmeType = isMsme ? (F.type ? normalizeMsmeType(p[F.type]) : 'Micro') : 'Not MSME';
      const rawVat = (p.vat || '').replace(/^IN/i, '');
      return {
        id:            p.id,
        vendor_name:   p.name,
        vendor_code:   p.ref || '',
        pan:           rawVat,   // portal normalisePartnerTaxFields will split GSTIN→PAN
        gstin:         rawVat,   // same source; portal will keep whichever is correct
        msme_type:     msmeType,
        is_msme:       isMsme,
        udyam_no:      F.no ? (p[F.no] || '') : '',
        state:         p.state_id   ? p.state_id[1]   : '',
        country:       p.country_id ? p.country_id[1] : '',
        contact:       p.mobile || p.phone || '',
        email:         p.email  || '',
        payment_terms: p.property_supplier_payment_term_id
                       ? p.property_supplier_payment_term_id[1] : ''
      };
    });

    console.log(`✅ Fetched ${formatted.length} total vendors`);
    res.json({ ok: true, count: formatted.length, data: formatted });

  } catch (e) {
    console.error('❌ Vendor master error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── POST /api/sync/bills ──────────────────────────────────────
// Fetches ALL posted vendor bills + credit notes for MSME vendors
// whose invoice_date falls within the selected half-year period.
// NO extra filtering — every bill in the date range is returned.
app.post('/api/sync/bills', async (req, res) => {
  const s = loadSettings();
  const { period = 'H1', fy = '2024-25' } = req.body;

  const fyStart = parseInt(fy.split('-')[0]);

  // Indian FY convention:
  //   H1 = Apr 1 → Sep 30  (first half)
  //   H2 = Oct 1 → Mar 31  (second half)
  let periodStart, periodEnd;
  if (period === 'H1') {
    periodStart = `${fyStart}-04-01`;
    periodEnd   = `${fyStart}-09-30`;
  } else {
    periodStart = `${fyStart}-10-01`;
    periodEnd   = `${fyStart + 1}-03-31`;
  }
  const periodEndDate = new Date(periodEnd);

  console.log(`\n📅 Bills sync | ${period} | FY ${fy} | ${periodStart} → ${periodEnd}`);

  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);
    const F = await detectMsmeFields(session);

    if (!F.status) {
      return res.status(400).json({ ok: false,
        error: 'MSME Status field not found. Open /api/detect-fields to debug.' });
    }

    // ── Step 1: All MSME vendors ──────────────────────────────────
    const partnerFields = ['id', 'name', F.status,
      ...(F.type ? [F.type] : []), ...(F.no ? [F.no] : [])];

    const allMsme = await odooCall(session, 'res.partner', 'search_read',
      [[['supplier_rank', '>', 0], [F.status, '=', 'Yes'], ['active', '=', true]]],
      { fields: partnerFields, limit: 5000 }
    );

    if (allMsme.length === 0) {
      return res.json({ ok: true, count: 0, data: [], message: 'No MSME vendors found' });
    }
    const msmeMap  = {};
    allMsme.forEach(p => { msmeMap[p.id] = p; });
    const msmeIds  = allMsme.map(p => p.id);
    console.log(`  ✅ ${allMsme.length} MSME vendors`);

    // ── Step 2: Fetch ALL bills in the period (no extra filter) ───
    // Includes in_invoice (vendor bill) + in_refund (credit note).
    // allowed_company_ids:[] fetches across all branches (BHR/, BWB/, BKN/, etc.)
    const bills = await odooCall(session, 'account.move', 'search_read',
      [[
        ['move_type', 'in', ['in_invoice', 'in_refund']],
        ['state',    '=',  'posted'],
        ['partner_id', 'in', msmeIds],
        ['invoice_date', '>=', periodStart],
        ['invoice_date', '<=', periodEnd]
      ]],
      {
        fields: ['id', 'name', 'ref', 'partner_id', 'invoice_date', 'date',
                 'move_type',
                 'amount_total', 'amount_residual', 'payment_state', 'line_ids'],
        limit: 10000,
        order: 'invoice_date asc',
        context: { lang: 'en_IN', allowed_company_ids: [] }
      }
    );

    console.log(`  ✅ ${bills.length} bills fetched from Odoo (${periodStart} → ${periodEnd})`);
    if (bills.length === 0) {
      return res.json({ ok: true, count: 0, data: [],
        message: `No posted bills for ${period} FY ${fy} (${periodStart} to ${periodEnd})` });
    }

    // ── Step 3: Payment terms removed — MSME due date is always invoice_date + 45 ──

    // ── Step 4: Get payable AP lines for reconciliation lookup ────
    const billIds = bills.map(b => b.id);
    let payableLineIds = [];
    const lineToBillId = {};

    for (let i = 0; i < billIds.length; i += 500) {
      try {
        const apLines = await odooCall(session, 'account.move.line', 'search_read',
          [[
            ['move_id', 'in', billIds.slice(i, i + 500)],
            ['account_type', 'in', ['liability_payable', 'asset_receivable']]
          ]],
          { fields: ['id', 'move_id'], limit: 10000 }
        );
        if (apLines.length > 0) {
          apLines.forEach(ml => {
            lineToBillId[ml.id] = ml.move_id?.[0];
            payableLineIds.push(ml.id);
          });
        } else {
          bills.slice(i, i + 500).forEach(b =>
            (b.line_ids || []).forEach(lid => { lineToBillId[lid] = b.id; payableLineIds.push(lid); })
          );
        }
      } catch (e) {
        bills.slice(i, i + 500).forEach(b =>
          (b.line_ids || []).forEach(lid => { lineToBillId[lid] = b.id; payableLineIds.push(lid); })
        );
      }
    }

    const allBillLineIds = [...new Set(payableLineIds)];
    console.log(`  ${allBillLineIds.length} payable lines for reconcile lookup`);

    // ── Step 5: Fetch reconciliations (payments) ──────────────────
    let reconciles = [];
    const seenRecIds = new Set();

    for (let i = 0; i < allBillLineIds.length; i += 500) {
      const batch = allBillLineIds.slice(i, i + 500);
      for (const [field, billSide, pmtSide] of [
        ['credit_move_id', 'credit_move_id', 'debit_move_id'],
        ['debit_move_id',  'debit_move_id',  'credit_move_id']
      ]) {
        try {
          const recs = await odooCall(session, 'account.partial.reconcile', 'search_read',
            [[[field, 'in', batch]]],
            { fields: ['id', 'debit_move_id', 'credit_move_id', 'amount', 'create_date'], limit: 5000 }
          );
          recs.forEach(r => {
            if (seenRecIds.has(r.id)) return;
            seenRecIds.add(r.id);
            reconciles.push({ ...r, _billLineId: r[billSide]?.[0], _paymentLineId: r[pmtSide]?.[0] });
          });
        } catch (e) { /* ignore batch error */ }
      }
    }
    console.log(`  ${reconciles.length} reconciliation entries`);

    // ── Step 6: Resolve payment move lines (dates + refs) ─────────
    const pmtLineIds = [...new Set(reconciles.map(r => r._paymentLineId).filter(Boolean))];
    const payLineMap = {};
    for (let i = 0; i < pmtLineIds.length; i += 500) {
      try {
        const pmtLines = await odooCall(session, 'account.move.line', 'search_read',
          [[['id', 'in', pmtLineIds.slice(i, i + 500)]]],
          { fields: ['id', 'move_id', 'date', 'name'], limit: 5000 }
        );
        pmtLines.forEach(ml => { payLineMap[ml.id] = ml; });
      } catch (e) { /* ignore */ }
    }

    // ── Step 7: Map payments to bills ────────────────────────────
    const billPayments = {};
    reconciles.forEach(r => {
      const billId = lineToBillId[r._billLineId];
      if (!billId) return;
      if (!billPayments[billId]) billPayments[billId] = [];
      const pLine = payLineMap[r._paymentLineId];
      billPayments[billId].push({
        ref:    pLine ? (pLine.move_id?.[1] || `PMT-${r.id}`) : `PMT-${r.id}`,
        date:   pLine?.date || (r.create_date || '').split(' ')[0] || '',
        amount: Math.round((r.amount || 0) * 100) / 100
      });
    });

    // Widget fallback for paid bills that have no reconcile entries
    const paidNoPayments = bills.filter(b =>
      b.payment_state !== 'not_paid' && (!billPayments[b.id] || billPayments[b.id].length === 0)
    );
    if (paidNoPayments.length > 0) {
      console.log(`  ⚠ ${paidNoPayments.length} paid bills — using widget fallback`);
      for (const bill of paidNoPayments) {
        try {
          const w = (await odooCall(session, 'account.move', 'read',
            [[bill.id]], { fields: ['invoice_payments_widget'] }))?.[0]?.invoice_payments_widget;
          if (w && w !== false) {
            const lines = (typeof w === 'string' ? JSON.parse(w) : w)?.content || [];
            if (lines.length > 0) {
              billPayments[bill.id] = lines.map(p => ({
                ref:    p.ref || p.move_id?.[1] || 'Payment',
                date:   p.date || p.payment_date || '',
                amount: Math.round((p.amount || 0) * 100) / 100
              }));
            }
          }
        } catch (e) { /* skip */ }
      }
    }

    // ── Step 8: Build output — ALL bills, no filtering ────────────
    const today      = new Date();
    const refDate    = periodEndDate < today ? periodEndDate : today;
    const workingData = [];
    let idx = 0;

    for (const bill of bills) {
      // MSME due date = invoice_date + 45 days (fixed per Section 43B(h))
      const dueDate = calcDueDate(bill.invoice_date);

      const partner    = msmeMap[bill.partner_id?.[0]];
      const payments   = billPayments[bill.id] || [];

      const paidAsOfPeriodEnd = Math.round(
        payments.filter(p => p.date && new Date(p.date) <= periodEndDate)
                .reduce((s, p) => s + p.amount, 0) * 100
      ) / 100;

      const totalPaid = Math.round(payments.reduce((s, p) => s + p.amount, 0) * 100) / 100;

      const outstandingAsOfPeriodEnd = Math.round(
        Math.max(0, bill.amount_total - paidAsOfPeriodEnd) * 100
      ) / 100;

      const outstanding = Math.round(Math.max(0,
        typeof bill.amount_residual === 'number' ? bill.amount_residual : bill.amount_total - totalPaid
      ) * 100) / 100;

      const daysOverdue    = Math.max(0, Math.floor((refDate - dueDate) / 86400000));
      const hasPaidLate    = payments.some(p => p.date && new Date(p.date) > dueDate);
      const isUnpaidAndOverdue = outstandingAsOfPeriodEnd > 0.01 && dueDate <= periodEndDate;

      const msmeType = (partner && F.type) ? normalizeMsmeType(partner[F.type]) : 'Unknown';
      const isMedium = msmeType === 'Medium';
      const isCreditNote = bill.move_type === 'in_refund';

      // Status label
      let status = 'Paid';
      if (isCreditNote)                               status = 'Credit Note';
      else if (outstanding > 0.01 && totalPaid === 0) status = 'Unpaid';
      else if (outstanding > 0.01)                   status = 'Partial';
      if (!isCreditNote && outstanding > 0.01 && daysOverdue > 0) status = 'Overdue';
      if (!isCreditNote && outstanding <= 0.01 && hasPaidLate)    status = 'Late-Paid';

      // Disallowable u/s 43B(h) — Micro & Small only, not credit notes
      let disallowable = 0;
      if (!isMedium && !isCreditNote) {
        disallowable = outstandingAsOfPeriodEnd;
        payments.forEach(p => {
          if (p.date && new Date(p.date) > dueDate && new Date(p.date) <= periodEndDate)
            disallowable += p.amount;
        });
        disallowable = Math.round(Math.min(disallowable, bill.amount_total) * 100) / 100;
      }

      // MSME-1: Micro & Small with overdue exposure; excludes Medium & credit notes
      const showInMsme1 = !isMedium && !isCreditNote && (hasPaidLate || isUnpaidAndOverdue);

      idx++;
      workingData.push({
        id:                           idx,
        odoo_id:                      bill.id,
        vendor_name:                  bill.partner_id?.[1] || '',
        msme_type:                    msmeType,
        move_type:                    bill.move_type || 'in_invoice',
        bill_no:                      bill.name || '',
        ref_no:                       bill.ref  || '',
        bill_date:                    bill.invoice_date || '',
        due_date:                     dueDate.toISOString().split('T')[0],
        credit_days:                  45,
        bill_amount:                  bill.amount_total || 0,
        payments,
        total_paid:                   totalPaid,
        outstanding,
        outstanding_as_of_period_end: outstandingAsOfPeriodEnd,
        days_overdue:                 daysOverdue,
        status,
        disallowable,
        show_in_msme1:                showInMsme1
      });
    }

    console.log(`\n✅ ${workingData.length} bills returned | ${period} FY ${fy}`);
    res.json({ ok: true, count: workingData.length, data: workingData });

  } catch (e) {
    console.error('❌ Bills error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── POST /api/sync/all ────────────────────────────────────────
app.post('/api/sync/all', async (req, res) => {
  const results = {};
  const errors  = [];
  const base    = `http://localhost:${PORT}`;
  for (const op of [
    { key: 'msmeVendors',  url: '/api/sync/msme-vendors',  body: {} },
    { key: 'vendorMaster', url: '/api/sync/vendor-master', body: {} },
    { key: 'bills',        url: '/api/sync/bills',         body: req.body || {} }
  ]) {
    try {
      const r = await fetch(`${base}${op.url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(op.body)
      });
      results[op.key] = await r.json();
    } catch (e) {
      errors.push({ key: op.key, error: e.message });
    }
  }
  res.json({ ok: errors.length === 0, results, errors });
});

// ── Serve Portal HTML ──────────────────────────────────────────
const portalFile = path.join(__dirname, 'msme-portal.html');
app.get('/', (req, res) => {
  fs.existsSync(portalFile)
    ? res.sendFile(portalFile)
    : res.send(`<h2 style="font-family:Segoe UI;padding:40px">⚠ Place msme-portal.html in: ${__dirname}</h2>`);
});

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  MSME Portal Proxy  v4.0  →  localhost:${PORT}     ║`);
  console.log(`║  Bills: ALL MSME types (Micro+Small+Medium)      ║`);
  console.log(`╠══════════════════════════════════════════════════╣`);
  console.log(`║  POST /api/test             test Odoo login      ║`);
  console.log(`║  GET  /api/detect-fields    list all x_ fields   ║`);
  console.log(`║  GET  /api/debug/bill?name= diagnose a bill      ║`);
  console.log(`║  POST /api/sync/msme-vendors                     ║`);
  console.log(`║  POST /api/sync/vendor-master                    ║`);
  console.log(`║  POST /api/sync/bills  { period, fy }            ║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  const s = loadSettings();
  if (s.url) console.log(`  Odoo: ${s.url}  DB: ${s.db}  User: ${s.username}\n`);
  else       console.log(`  ⚠ No settings yet — open http://localhost:${PORT} → Settings\n`);
});
