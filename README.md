# MSME Portal — Odoo Proxy Server

## What is this?
A lightweight Node.js server that acts as a **bridge** between your MSME Portal HTML and Odoo.

```
[Browser / HTML Portal] ←→ [localhost:3001 Proxy] ←→ [ginesys.odoo.com]
```
This fixes the CORS issue — browser cannot call Odoo directly, but it CAN call localhost.

---

## Setup (One Time)

### Step 1 — Install Node.js
Download from https://nodejs.org (choose LTS version)

### Step 2 — Put files in same folder
```
📁 msme-portal/
   ├── server.js          ← proxy server
   ├── package.json
   ├── START-SERVER.bat   ← double-click to start
   └── msme-portal.html   ← your portal file
```

### Step 3 — Start the server
**Option A:** Double-click `START-SERVER.bat`

**Option B:** Open terminal in this folder and run:
```
npm install
node server.js
```

### Step 4 — Open the portal
Go to: http://localhost:3001

---

## Odoo Setup Required

### Custom Fields on res.partner (Vendors)
Add these fields in Odoo → Settings → Technical → Fields:
| Field Name        | Type      | Label              |
|-------------------|-----------|--------------------|
| x_msme_type       | Selection | MSME Type          |
| x_udyam_no        | Char      | Udyam Reg. No.     |
| x_msme_reg_date   | Date      | MSME Reg. Date     |
| x_msme_expiry     | Date      | Certificate Expiry |

Selection values for x_msme_type: `Micro`, `Small`, `Medium`

### Vendor Tags
Create a tag called **"MSME"** in Odoo → Contacts → Tags
Tag all your MSME vendors with this tag

---

## API Endpoints

| Method | URL                       | Description                     |
|--------|---------------------------|---------------------------------|
| GET    | /health                   | Check if proxy is running       |
| POST   | /api/test                 | Test Odoo connection            |
| GET    | /api/settings             | Load saved Odoo credentials     |
| POST   | /api/settings             | Save Odoo credentials           |
| POST   | /api/sync/msme-vendors    | Fetch MSME tagged vendors       |
| POST   | /api/sync/vendor-master   | Fetch all vendors               |
| POST   | /api/sync/bills           | Fetch bills with payments       |
| POST   | /api/sync/all             | Sync everything at once         |

---

## Settings File
Your Odoo credentials are saved in `odoo-settings.json` (local, not sent anywhere).

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Proxy Offline" in portal | Run `node server.js` first |
| "Authentication failed" | Check username/API key in Settings |
| No vendors showing | Add "MSME" tag to vendors in Odoo |
| Bills not loading | Check vendor has MSME tag + bills posted |
| x_msme_type field missing | Create custom field in Odoo |

---

## For Electron App
If you use this inside Electron, you can call the proxy from the renderer:
```javascript
fetch('http://localhost:3001/api/sync/bills', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({period:'H1', fy:'2024-25'})
})
```
