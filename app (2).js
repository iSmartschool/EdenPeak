/* iSmartSchool – application (screens). Server calls go through ISSApi (api.js). */
'use strict';
var App = {
  token: '',
  user: null,
  PAGE_SIZE: 50,
  _stPage: 1, _stData: [], _stFilter: 'All', _stSearch: '',
  _expPage: 1, _expData: [],
  _inflight: {},
  _expiredHandled: false,
  _cache: { classes:null, students:null, studentIdx:null, config:null, crest:null, expenses:null, expCats:null },
  pages: {
    dashboard:{icon:'📋'}, students:{icon:'👥'}, fees:{icon:'💰'}, canteen:{icon:'🍽️'}, finances:{icon:'📊'},
    expenses:{icon:'💸'}, payroll:{icon:'🧑‍💼'}, results:{icon:'📝'}, report:{icon:'📄'}, attendance:{icon:'📅'},
    promotion:{icon:'📈'}, settings:{icon:'⚙️'}, curriculum:{icon:'📚'}
  },
  TERM_NAMES: ['','First Term','Second Term','Third Term'],

  /* ── Server calls. Session expiry now logs the user out cleanly instead of
     leaving every screen showing a raw "Session expired" error. ── */
  call: function(fn, params, dedupKey) {
    var s = this;
    params = params || {};
    params.token = s.token;
    if (dedupKey && s._inflight[dedupKey]) return s._inflight[dedupKey];
    // Transport, offline cache and the offline outbox live in assets/js/api.js.
    var p = ISSApi.call(fn, params).catch(function(err) {
      var msg = (err && err.message) ? err.message : String(err);
      if (/Session expired|Not authenticated/i.test(msg) && s.user) s._handleExpiredSession();
      throw (err instanceof Error ? err : new Error(msg));
    });
    if (dedupKey) {
      s._inflight[dedupKey] = p;
      p.then(function(){ delete s._inflight[dedupKey]; }, function(){ delete s._inflight[dedupKey]; });
    }
    return p;
  },
  _handleExpiredSession: function() {
    if (this._expiredHandled) return;
    this._expiredHandled = true;
    this.logout(true);
    this.modal.alert('Your session has expired. Please sign in again.');
  },

  /* FIX: the old version used textContent→innerHTML, which does NOT escape
     quotes, so any name containing " broke out of value="…" attributes. */
  escapeHtml: function(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  },
  debounce: function(fn, ms) {
    var t; return function() { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function(){ fn.apply(c,a); }, ms); };
  },
  money: function(v) { return 'GH₵ ' + (parseFloat(v) || 0).toFixed(2); },
  niceDate: function(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return ymd || '';
    return new Date(+m[1], +m[2]-1, +m[3]).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
  },
  todayYMD: function() {
    var d = new Date(); return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2);
  },
  newIdemKey: function() { return 'idem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); },
  errHtml: function(e) { return '<p style="color:var(--red);text-align:center;padding:20px;">Error: ' + this.escapeHtml(e && e.message ? e.message : e) + '</p>'; },
  spinner: '<div style="text-align:center;padding:40px;"><div class="loading-spinner"></div></div>',

  /* ── Role helpers: buttons a role can't use are no longer shown. ── */
  role: function() { return (this.user && this.user.role) || ''; },
  isAdmin: function() { return this.role() === 'Admin'; },
  // Permissions come from the server (Settings → Permissions).
  can: function(action) { return this.isAdmin() || !!(this.user && (this.user.permissions||[]).indexOf(action) >= 0); },
  hasPage: function(page) { return this.isAdmin() || !!(this.user && (this.user.allowedPages||[]).indexOf(page) >= 0); },
  canManageStudents: function() { return this.can('students.edit'); },

  classOptions: function(cl, includeAll, selected, placeholder) {
    var s = this;
    var head = includeAll ? '<option value="All">All Classes</option>' : (placeholder ? '<option value="">' + s.escapeHtml(placeholder) + '</option>' : '');
    return head + cl.map(function(c){ return '<option value="'+s.escapeHtml(c.code)+'"'+(c.code===selected?' selected':'')+'>'+s.escapeHtml(c.name)+'</option>'; }).join('');
  },
  studentOptions: function(students, classFilter, placeholder) {
    var s = this;
    var list = classFilter && classFilter !== 'All' ? students.filter(function(st){ return st.Class === classFilter; }) : students;
    return (placeholder ? '<option value="">' + s.escapeHtml(placeholder) + '</option>' : '') +
      list.map(function(st){ return '<option value="'+s.escapeHtml(st.StudentID)+'">'+s.escapeHtml(st.FullName)+' ('+s.escapeHtml(st.Class)+')</option>'; }).join('');
  },

  getClasses: function() {
    var s = this;
    if (s._cache.classes) return Promise.resolve(s._cache.classes);
    return s.call('getClasses', {}, 'getClasses').then(function(cl) { s._cache.classes = cl || []; return s._cache.classes; });
  },
  getStudents: function(classFilter) {
    var s = this;
    var load = s._cache.students
      ? Promise.resolve(s._cache.students)
      : s.call('getAllStudents', {}, 'getAllStudents').then(function(list) {
          list = list || [];
          s._cache.students = list; s._cache.studentIdx = {};
          list.forEach(function(st) { s._cache.studentIdx[st.StudentID] = st; });
          return list;
        });
    return load.then(function(list) {
      return (!classFilter || classFilter === 'All') ? list : list.filter(function(st){ return st.Class === classFilter; });
    });
  },
  invalidateStudents: function() { this._cache.students = null; this._cache.studentIdx = null; },
  getStudentCached: function(sid) {
    if (this._cache.studentIdx && this._cache.studentIdx[sid]) return Promise.resolve(this._cache.studentIdx[sid]);
    return this.call('getStudentById', { sid: sid });
  },
  getConfig: function() {
    var s = this;
    if (s._cache.config) return Promise.resolve(s._cache.config);
    return s.call('getSchoolConfig', {}, 'getConfig').then(function(c) { s._cache.config = c; return c; });
  },
  getExpensesCached: function() {
    var s = this;
    if (s._cache.expenses) return Promise.resolve(s._cache.expenses);
    return s.call('getExpenses', {}, 'getExpenses').then(function(list) { s._cache.expenses = list || []; return s._cache.expenses; });
  },
  invalidateExpenses: function() { this._cache.expenses = null; },
  _resetPagination: function() { this._stPage=1; this._expPage=1; this._feeOvPage=1; },

  /* ── Modal ──
     FIX: buttons used to close (and wipe) the modal BEFORE running their
     callback, so "Edit Category" and "Edit User" read inputs that no longer
     existed and crashed. The callback now runs first; returning false keeps
     the modal open (for validation). alert() now escapes its text. */
  modal: {
    show: function(title, html, buttons) {
      document.getElementById('modalContainer').innerHTML =
        '<div class="modal-overlay" id="mOverlay"><div class="modal-box">' +
        '<h3 style="color:var(--green)">' + title + '</h3>' +
        '<div style="margin:15px 0;color:var(--text-secondary)">' + html + '</div><div>' +
        buttons.map(function(b,i){ return '<button class="btn '+(b.cls||'')+'" id="mb'+i+'">'+b.text+'</button>'; }).join('') +
        '</div></div></div>';
      var overlay = document.getElementById('mOverlay');
      buttons.forEach(function(b,i){
        document.getElementById('mb'+i).onclick = function(){
          var keep = b.cb ? b.cb() : undefined;
          if (keep === false) return;
          if (document.getElementById('mOverlay') === overlay) App.modal.close();
        };
      });
      overlay.onclick = function(e){ if (e.target === overlay) App.modal.close(); };
    },
    close: function() { document.getElementById('modalContainer').innerHTML = ''; },
    alert:   function(m){ return new Promise(function(r){ App.modal.show('Notice', App.escapeHtml(m).replace(/\n/g,'<br>'), [{text:'OK',cb:r}]); }); },
    // confirm() accepts HTML — callers must escape any data they interpolate.
    confirm: function(m){ return new Promise(function(r){
      App.modal.show('Confirm', m, [{text:'Yes',cls:'btn-danger',cb:function(){r(true);}},{text:'Cancel',cls:'btn-secondary',cb:function(){r(false);}}]);
    }); }
  },

  showDangerConfirm: function(opts) {
    var keyword = (opts.keyword || 'CONFIRM').toUpperCase();
    var warningsHtml = (opts.warnings && opts.warnings.length)
      ? '<ul class="warning-list">' + opts.warnings.map(function(w){ return '<li>' + App.escapeHtml(w) + '</li>'; }).join('') + '</ul>' : '';
    var overlay = document.createElement('div');
    overlay.className = 'danger-modal-overlay';
    overlay.innerHTML =
      '<div class="danger-modal">' +
        '<div class="modal-icon">' + (opts.icon || '⚠️') + '</div>' +
        '<h2>' + App.escapeHtml(opts.title) + '</h2>' +
        '<p class="modal-subtitle">' + App.escapeHtml(opts.subtitle || '') + '</p>' + warningsHtml +
        (opts.options || []).map(function(o){ return '<label style="display:flex;gap:10px;align-items:flex-start;background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer;color:var(--text-primary);font-size:13px;"><input type="checkbox" data-opt="'+App.escapeHtml(o.key)+'"'+(o.checked?' checked':'')+' style="width:18px;height:18px;margin-top:1px;flex-shrink:0;"><span>'+App.escapeHtml(o.label)+(o.hint?'<br><span style="color:var(--text-muted);font-size:12px;">'+App.escapeHtml(o.hint)+'</span>':'')+'</span></label>'; }).join('') +
        '<div class="confirm-input-wrap"><label>Type <strong style="color:var(--red);letter-spacing:2px;">' + keyword + '</strong> to unlock this action:</label>' +
          '<input class="danger-key" type="text" placeholder="' + keyword + '" autocomplete="off"></div>' +
        '<div class="danger-modal-actions">' +
          '<button class="danger-cancel" style="background:var(--bg-input);color:var(--text-secondary);">Cancel</button>' +
          '<button class="danger-ok" disabled style="background:' + (opts.confirmColor || 'var(--red)') + ';color:white;">' + App.escapeHtml(opts.confirmLabel || 'Proceed') + '</button>' +
        '</div></div>';
    document.body.appendChild(overlay);
    var input = overlay.querySelector('.danger-key'), ok = overlay.querySelector('.danger-ok');
    input.focus();
    input.addEventListener('input', function() { ok.disabled = this.value.trim().toUpperCase() !== keyword; });
    overlay.querySelector('.danger-cancel').onclick = function() { overlay.remove(); };
    ok.onclick = function() {
      var chosen = {};
      overlay.querySelectorAll('[data-opt]').forEach(function(cb){ chosen[cb.getAttribute('data-opt')] = cb.checked; });
      overlay.remove(); if (opts.onConfirm) opts.onConfirm(chosen);
    };
    overlay.addEventListener('click', function(e){ if (e.target === overlay) overlay.remove(); });
  },

  showResultModal: function(opts) {
    var rowsHtml = (opts.rows || []).map(function(r) {
      return '<div class="result-row"><span style="color:var(--text-muted);">' + App.escapeHtml(r.label) + '</span>' +
        '<span style="font-weight:700;color:' + (r.color || 'var(--text-primary)') + ';">' + App.escapeHtml(String(r.value)) + '</span></div>';
    }).join('');
    var overlay = document.createElement('div');
    overlay.className = 'result-modal-overlay';
    overlay.innerHTML = '<div class="result-modal"><div class="modal-icon">' + (opts.icon || '✅') + '</div>' +
      '<h2>' + App.escapeHtml(opts.title) + '</h2><div class="result-box">' + rowsHtml + '</div>' +
      '<button class="btn result-close" style="margin-top:8px;width:100%;padding:14px;">✓ Close</button></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.result-close').onclick = function() { overlay.remove(); if (opts.onClose) opts.onClose(); };
  },

  safeSubmit: function(btn, fn) {
    if (!btn || btn.disabled) return;
    btn.disabled = true; var t = btn.textContent; btn.textContent = '⏳ Saving…';
    var p; try { p = fn(); } catch (e) { p = Promise.reject(e); }
    if (!p || typeof p.then !== 'function') p = Promise.resolve();
    p.then(function(){ btn.disabled=false; btn.textContent=t; })
     .catch(function(e){ btn.disabled=false; btn.textContent=t; App.modal.alert('Error: '+(e && e.message ? e.message : e)); });
  },

  resizeImage: function(file, maxPx) {
    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function(e) {
        var img = new Image();
        img.onload = function() {
          var scale = Math.min(1, maxPx / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.75));
        };
        img.onerror = reject; img.src = e.target.result;
      };
      reader.onerror = reject; reader.readAsDataURL(file);
    });
  },

  /* ── Printing ── */
  addPrintButtons_: function() {
    var ex = document.querySelector('.print-action-buttons'); if (ex) ex.remove();
    var d = document.createElement('div'); d.className = 'print-action-buttons';
    d.innerHTML = '<button id="pCancelBtn" style="background:#ff3d5a;color:white;padding:14px 30px;border:none;border-radius:30px;cursor:pointer;font-weight:700;">✕ Close</button>' +
                  '<button id="pPrintBtn" style="background:#00c853;color:white;padding:14px 30px;border:none;border-radius:30px;cursor:pointer;font-weight:700;">🖨️ Print</button>';
    document.getElementById('printOverlay').appendChild(d);
    document.getElementById('pCancelBtn').onclick = function(){ App.closePrint(); };
    document.getElementById('pPrintBtn').onclick  = function(){ window.print(); };
  },
  // On a phone, shrink the print preview (receipt, payslips, report card) to
  // the screen width. Screen only — printing is always at full size.
  fitPrintPreview: function(){
    var po=document.getElementById('printOverlay'); if (!po || po.style.display==='none') return;
    var avail=po.clientWidth-24;
    [].slice.call(document.getElementById('printContent').children).forEach(function(c){
      c.style.removeProperty('--fit');
      var w=c.scrollWidth; if (w>avail && avail>0) c.style.setProperty('--fit', (avail/w).toFixed(3));
    });
  },
  closePrint: function() {
    document.getElementById('printOverlay').style.display = 'none';
    document.getElementById('printContent').innerHTML = '';
    var b = document.querySelector('.print-action-buttons'); if (b) b.remove();
  },
  setPrintPageStyle: function(css) {
    var el = document.getElementById('dynamicPrintPageStyle');
    if (!el) { el = document.createElement('style'); el.id = 'dynamicPrintPageStyle'; document.head.appendChild(el); }
    el.textContent = css;
  },
  printContent: function(pageCss, exact) {
    var po = document.getElementById('printOverlay');
    po.style.cssText = 'display:block;background:#fff;color:#1a1a1a;padding:30px 30px 100px;';
    po.classList.toggle('exact', !!exact);
    this.setPrintPageStyle(pageCss || '@page { size: A4 portrait; margin: 15mm; }');
    this.addPrintButtons_();
    this.fitPrintPreview();
  },

  /* ── Receipts: one professional layout, exactly 140 mm × 105 mm ──
     o = { title, number, date, school:{name,motto,address,phone,email,crest},
           payer:[[label,value]×4], items:[{desc, amount}], total, method, reference,
           summaryTitle, summary:[[label, value, colour?]…], issuedBy, note, stamp } */
  _receiptHTML: function(o){
    var s=this, E=function(v){ return s.escapeHtml(v===undefined||v===null?'':v); };
    var money=function(v){ return 'GH₵ '+(parseFloat(v)||0).toLocaleString('en-GH',{minimumFractionDigits:2,maximumFractionDigits:2}); };
    var sc=o.school||{}, ink='#1b2733', green='#0b5d3b', muted='#5f6b76', line='#d5dbe0';
    var lab=function(t){ return '<div style="font-size:5.6pt;letter-spacing:.5pt;text-transform:uppercase;color:'+muted+';">'+t+'</div>'; };
    var crest=sc.crest?'<img src="'+E(sc.crest)+'" style="width:100%;height:100%;object-fit:contain;" alt="">':'<span style="font-size:20pt;">🏫</span>';
    var payer=(o.payer||[]).map(function(p){ return '<div style="min-width:0;">'+lab(E(p[0]))+'<div style="font-size:8pt;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+E(p[1]||'—')+'</div></div>'; }).join('');
    var items=(o.items||[]).map(function(it){ return '<tr><td style="padding:1.2mm 1.5mm;border-bottom:.2mm solid '+line+';">'+E(it.desc)+'</td><td style="padding:1.2mm 1.5mm;border-bottom:.2mm solid '+line+';text-align:right;white-space:nowrap;">'+money(it.amount)+'</td></tr>'; }).join('');
    var details=[['Method',o.method],['Reference',o.reference],['Received by',o.issuedBy]].filter(function(d){ return d[1]; })
      .map(function(d){ return '<div>'+lab(d[0])+'<div style="font-size:7.5pt;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40mm;">'+E(d[1])+'</div></div>'; }).join('');
    var summary=(o.summary||[]).map(function(r){ return '<tr><td style="padding:.5mm 0;color:'+muted+';font-size:7pt;">'+E(r[0])+'</td><td style="padding:.5mm 0;text-align:right;font-weight:700;font-size:7.5pt;color:'+(r[2]||ink)+';white-space:nowrap;">'+E(r[1])+'</td></tr>'; }).join('');
    var stamp=o.stamp||'PAID', stampCol=stamp==='PAID'?'rgba(11,93,59,.6)':'rgba(180,35,24,.7)';
    return '<div class="receipt-140" style="width:140mm;height:105mm;box-sizing:border-box;margin:0 auto;background:#fff;color:'+ink+';font-family:\'Segoe UI\',Arial,Helvetica,sans-serif;border:.25mm solid '+line+';border-top:1.6mm solid '+green+';padding:4mm 6mm 3mm;overflow:hidden;display:flex;flex-direction:column;">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:3mm;">'+
        '<div style="display:flex;gap:2.5mm;align-items:center;min-width:0;">'+
          '<div style="width:12mm;height:12mm;flex-shrink:0;display:flex;align-items:center;justify-content:center;">'+crest+'</div>'+
          '<div style="min-width:0;"><div style="font-family:Georgia,\'Times New Roman\',serif;font-size:11pt;font-weight:700;color:'+green+';text-transform:uppercase;line-height:1.1;">'+E(sc.name)+'</div>'+
            (sc.motto?'<div style="font-size:6.5pt;font-style:italic;color:'+muted+';">'+E(sc.motto)+'</div>':'')+
            '<div style="font-size:6.2pt;color:'+muted+';line-height:1.35;margin-top:.5mm;">'+E(sc.address)+'<br>'+[sc.phone,sc.email].filter(Boolean).map(E).join(' · ')+'</div></div></div>'+
        '<div style="text-align:right;flex-shrink:0;">'+
          '<div style="display:inline-block;border:.35mm solid '+green+';color:'+green+';font-weight:800;font-size:7pt;letter-spacing:1.2pt;padding:.8mm 2mm;">'+E(o.title||'OFFICIAL RECEIPT')+'</div>'+
          '<div style="font-size:6.5pt;color:'+muted+';margin-top:1.2mm;">No. <span style="font-family:\'Courier New\',monospace;font-weight:700;font-size:8pt;color:'+ink+';">'+E(o.number)+'</span></div>'+
          '<div style="font-size:6.5pt;color:'+muted+';">Date <b style="color:'+ink+';">'+E(s.niceDate(o.date))+'</b></div></div></div>'+
      '<div style="border-bottom:.7mm double '+green+';margin:2mm 0 1.8mm;"></div>'+
      '<div style="display:grid;grid-template-columns:1.6fr 1fr .7fr 1.3fr;gap:2.5mm;">'+payer+'</div>'+
      '<table style="width:100%;border-collapse:collapse;font-size:7.8pt;margin-top:2mm;">'+
        '<tr style="background:#f1f5f3;"><td style="padding:.9mm 1.5mm;font-size:5.8pt;letter-spacing:.5pt;color:'+muted+';">DESCRIPTION</td><td style="padding:.9mm 1.5mm;font-size:5.8pt;letter-spacing:.5pt;color:'+muted+';text-align:right;">AMOUNT</td></tr>'+items+
        '<tr><td style="padding:1.5mm 1.5mm 0;text-align:right;font-weight:700;font-size:7pt;letter-spacing:.6pt;">TOTAL PAID</td><td style="padding:1.5mm 1.5mm 0;text-align:right;font-weight:800;font-size:11pt;color:'+green+';white-space:nowrap;">'+money(o.total)+'</td></tr></table>'+
      '<div style="font-size:6.8pt;margin-top:1mm;padding:1mm 2mm;background:#f7f9f8;border-left:.6mm solid '+green+';"><span style="color:'+muted+';">Amount in words:</span> <b>'+E(s._amountInWords(o.total))+'</b></div>'+
      '<div style="display:flex;gap:3mm;margin-top:2mm;align-items:stretch;">'+
        '<div style="flex:1;display:flex;flex-direction:column;gap:1.2mm;position:relative;">'+details+
          '<span style="position:absolute;right:2mm;bottom:0;transform:rotate(-10deg);border:.5mm solid '+stampCol+';color:'+stampCol+';font-weight:900;font-size:11pt;letter-spacing:2pt;padding:.3mm 2.5mm;border-radius:1mm;">'+E(stamp)+'</span></div>'+
        (summary?'<div style="width:55mm;border:.25mm solid '+line+';border-radius:1mm;padding:1.2mm 2mm;"><div style="font-size:5.8pt;letter-spacing:.6pt;text-transform:uppercase;color:'+green+';font-weight:700;">'+E(o.summaryTitle||'Account summary')+'</div><table style="width:100%;border-collapse:collapse;">'+summary+'</table></div>':'')+
      '</div>'+
      '<div style="margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;gap:4mm;">'+
        '<div style="flex:1;"><div style="border-top:.25mm solid '+ink+';padding-top:.6mm;font-size:6pt;color:'+muted+';">Authorised signature</div></div>'+
        '<div style="width:24mm;height:10mm;border:.25mm dashed '+line+';display:flex;align-items:center;justify-content:center;font-size:5.5pt;color:#a9b2ba;letter-spacing:.6pt;">SCHOOL STAMP</div></div>'+
      '<div style="margin-top:1.2mm;display:flex;justify-content:space-between;gap:2mm;font-size:5.4pt;color:#8a949d;"><span>'+E(o.note||'Thank you. Please keep this receipt.')+'</span><span style="white-space:nowrap;">Printed '+E(new Date().toLocaleDateString('en-GB'))+' · iSmartSchool</span></div>'+
    '</div>';
  },
  _showReceipt: function(html){
    document.getElementById('printContent').innerHTML=html;
    App.printContent('@page { size: 140mm 105mm; margin: 0; }', true);
  },
  printReceipt: function(tid) {
    var s=this;
    s.call('getPrintableReceipt', { tid: tid }).then(function(rc) {
      if (!rc) { s.modal.alert('Receipt not found.'); return; }
      var out=parseFloat(rc.outstandingBalance)||0, termTxt=(s.TERM_NAMES[rc.Term]||('Term '+rc.Term))+' '+(rc.AcademicYear||'');
      var curTerm=(s.TERM_NAMES[rc.currentTerm]||('Term '+rc.currentTerm))+' '+(rc.currentYear||'');
      s._showReceipt(s._receiptHTML({
        title:'OFFICIAL RECEIPT', number:rc.ReceiptNumber, date:rc.PaymentDate,
        school:{ name:rc.schoolName, motto:rc.schoolMotto, address:rc.schoolAddress, phone:rc.schoolPhone, email:rc.schoolEmail, crest:rc.schoolCrest },
        payer:[['Student',rc.StudentName],['Student ID',rc.StudentID],['Class',rc.Class],['Term',termTxt]],
        items:[{ desc:(rc.FeeType==='Arrears'?'Arrears (brought forward from previous terms)':(rc.FeeType||'School fees')+' — '+termTxt), amount:rc.AmountPaid }],
        stamp: rc.Status==='Reversed' ? 'REVERSED' : 'PAID',
        total:rc.AmountPaid, method:rc.PaymentMethod, reference:rc.MoMoTransactionID, issuedBy:rc.issuedBy,
        summaryTitle:'Fees account — '+curTerm,
        summary:[['Total fees due', s.money(rc.termDue)], ['Paid to date', s.money(rc.termPaid)],
                 out>0.004 ? ['Outstanding fees', s.money(out), '#b42318'] : out<-0.004 ? ['Credit', s.money(-out), '#0b5d3b'] : ['Outstanding fees','Nil — fully paid','#0b5d3b']],
        note:'Thank you. Valid only with an authorised signature or school stamp.'
      }));
    }).catch(function(e){ s.modal.alert('Error: '+e.message); });
  },
  gradeColor: function(g) {
    return {1:'#00c853',2:'#00bcd4',3:'#7c4dff',4:'#ff9100',5:'#ffc107',6:'#ff9800',7:'#e91e63',8:'#9c27b0',9:'#ff3d5a'}[g]||'#607d8b';
  },
  _ordinal: function(n) {
    n = parseInt(n, 10);
    if (isNaN(n) || n <= 0) return '—';
    var suffixes = ['th','st','nd','rd'], v = n % 100;
    return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
  },
  _numberToWords: function(n) {
    var ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
    var tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
    var three = function(num) {
      var str = '';
      if (num >= 100) { str += ones[Math.floor(num/100)] + ' Hundred '; num %= 100; }
      if (num >= 20)  { str += tens[Math.floor(num/10)] + ' '; num %= 10; }
      if (num > 0)    { str += ones[num] + ' '; }
      return str.trim();
    };
    n = Math.floor(Math.max(0, n));
    if (n === 0) return 'Zero';
    var parts = [], million = Math.floor(n / 1e6); n %= 1e6;
    var thousand = Math.floor(n / 1e3); n %= 1e3;
    if (million)  parts.push(three(million) + ' Million');
    if (thousand) parts.push(three(thousand) + ' Thousand');
    if (n)        parts.push(three(n));
    return parts.join(' ').trim();
  },
  // FIX: worked in integer pesewas so e.g. 1.999 no longer prints "100 Pesewas".
  _amountInWords: function(amount) {
    var total = Math.round((parseFloat(amount) || 0) * 100), cedis = Math.floor(total / 100), pesewas = total % 100;
    var words = this._numberToWords(cedis) + ' Cedi' + (cedis === 1 ? '' : 's');
    if (pesewas > 0) words += ' and ' + this._numberToWords(pesewas) + ' Pesewa' + (pesewas === 1 ? '' : 's');
    return words + ' Only';
  },

  _buildPagination: function(page, pages, total, start, onPageChange) {
    var s = this, pg = document.createElement('div'); pg.className = 'pagination';
    var mkB = function(lbl, p) {
      var b = document.createElement('button');
      b.className = 'page-btn' + (p === page ? ' active' : '');
      b.textContent = lbl;
      if (p !== page) b.onclick = function(){ onPageChange(p); };
      return b;
    };
    if (page > 1) pg.appendChild(mkB('«', page-1));
    for (var p = Math.max(1,page-2); p <= Math.min(pages,page+2); p++) pg.appendChild(mkB(p,p));
    if (page < pages) pg.appendChild(mkB('»', page+1));
    var info = document.createElement('span'); info.className = 'page-info';
    info.textContent = (start+1)+'–'+Math.min(start+s.PAGE_SIZE,total)+' of '+total;
    pg.appendChild(info);
    return pg;
  },
  _buildTable: function(headers, rows) {
    var wrap = document.createElement('div'); wrap.className = 'table-wrap';
    var tbl = document.createElement('table'); tbl.className = 'data-table';
    var hr = tbl.createTHead().insertRow();
    headers.forEach(function(h){ var th=document.createElement('th'); th.textContent=h; hr.appendChild(th); });
    var body = tbl.createTBody();
    rows.forEach(function(r){ body.appendChild(r); });
    wrap.appendChild(tbl);
    return wrap;
  },
  _btn: function(label, cls, onClick, extraCss) {
    var b = document.createElement('button');
    b.className = 'btn btn-sm ' + (cls || ''); b.textContent = label;
    if (extraCss) b.style.cssText = extraCss;
    b.onclick = onClick; return b;
  },

  /* ═══ ROUTING & INIT ═══ */
  checkSetup: function() {
    var s = this, saved = s._readSession();
    if (saved && saved.token) {
      s.token = saved.token; s._remember = !!saved.remember;
      // Server is the source of truth for role/name/pages. When the device is
      // offline, the profile saved at the last sign-in is used until the
      // connection returns (it is re-checked then).
      s.call('validateSession', {}, 'validateSession').then(function(r) {
        if (r && r.valid) { s._startSession(r); }
        else { s.token=''; s._clearSession(); s.showLoginForm(); }
      }).catch(function(e){
        if (e && e.offline && saved.user) { s._startSession(saved.user, true); return; }
        s.token=''; s._clearSession(); s.showLoginForm();
      });
    } else { s.showLoginForm(); }
  },
  _startSession: function(user, offline) {
    this.user = user; this._expiredHandled = false; this._offlineStart = !!offline;
    this._saveSession();
    ISSApi.setSession({ email: user.email, token: this.token });
    this.hideLogin(); this.initSidebar();
    var pages = user.allowedPages || [];
    var want = null; try { want = new URLSearchParams(location.search).get('page'); } catch (e) {}
    this.switchPage(want && pages.indexOf(want) >= 0 ? want : (pages.indexOf('dashboard') >= 0 ? 'dashboard' : (pages[0] || 'dashboard')));
    if (window.ISSSync) ISSSync.onSessionStart(!!offline);
  },
  /* ── Saved sign-in. "Keep me signed in" → localStorage (survives closing
     the app, needed to open it offline); otherwise sessionStorage (ends when
     the tab or window closes). Only the session token and the profile the
     server returned are kept — never the password. ── */
  _SESSION_KEY: 'iss-session' + ISSApi.nsSuffix,   // one sign-in slot per school copy
  _readSession: function() {
    var raw = null;
    try { raw = sessionStorage.getItem(this._SESSION_KEY) || localStorage.getItem(this._SESSION_KEY); } catch (e) {}
    try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  },
  _saveSession: function() {
    if (!this.token || !this.user) return;
    var data = JSON.stringify({ token: this.token, user: this.user, remember: !!this._remember, savedAt: new Date().toISOString() });
    try {
      (this._remember ? localStorage : sessionStorage).setItem(this._SESSION_KEY, data);
      (this._remember ? sessionStorage : localStorage).removeItem(this._SESSION_KEY);
    } catch (e) {}
  },
  _clearSession: function() {
    try { sessionStorage.removeItem(this._SESSION_KEY); localStorage.removeItem(this._SESSION_KEY); sessionStorage.removeItem('authToken'); } catch (e) {}
    ISSApi.setSession(null);
  },
  showLoginForm: function() {
    var s = this;
    s.call('getPublicConfig', {}, 'publicConfig').then(function(r) {
      if (r && r.schoolName) document.getElementById('loginSubtitle').textContent = r.schoolName;
      if (r && r.schoolCrest) { s._cache.crest = r.schoolCrest; document.getElementById('loginLogo').innerHTML = '<img src="'+s.escapeHtml(r.schoolCrest)+'" style="max-width:120px;max-height:120px;">'; }
      if (r && r.needsSetup) s.showSetup(); else s.showLogin();
    }).catch(function(e){
      document.getElementById('loginError').textContent = (e && (e.offline || e.code === 'NOT_CONFIGURED')) ? e.message : 'Cannot connect to the server.';
      s.showLogin();
    });
  },
  showSetup: function() {
    document.getElementById('setupForm').innerHTML =
      '<h2 style="color:var(--gold)">Create Admin</h2>' +
      '<input id="suName" class="form-control" placeholder="Full Name">' +
      '<input id="suEmail" class="form-control" type="email" placeholder="Email">' +
      '<input id="suPass" class="form-control" type="password" placeholder="Password (min 6 characters)">' +
      '<button class="btn" id="setupBtn" style="width:100%">Create Account</button>';
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('setupBtn').onclick = function() {
      var b = this;
      App.safeSubmit(b, function() {
        return App.call('registerFirstAdmin',{email:document.getElementById('suEmail').value.trim(),password:document.getElementById('suPass').value,name:document.getElementById('suName').value.trim()})
          .then(function(r){ return App.modal.alert(r.message).then(function(){ if(r.success){ document.getElementById('setupForm').innerHTML=''; App.showLogin(); } }); });
      });
    };
  },
  showLogin: function() {
    document.getElementById('loginForm').style.display = 'block';
    var submit = function() {
      App.safeSubmit(document.getElementById('loginBtn'), function() {
        var email=document.getElementById('loginEmail').value.trim(), pass=document.getElementById('loginPassword').value, err=document.getElementById('loginError');
        err.textContent='';
        if (!email||!pass) { err.textContent='Please fill all fields.'; return Promise.resolve(); }
        return App.call('loginUser',{email:email,password:pass}).then(function(r){
          if (r.success) {
            App.token = r.token;
            App._remember = !!(document.getElementById('loginRemember') || {}).checked;
            if (App._remember) ISSApi.requestPersistentStorage();
            document.getElementById('loginPassword').value = '';
            App._startSession(r.user);
          } else { err.textContent = r.message || 'Login failed.'; }
        }).catch(function(ex){ err.textContent='Error: '+ex.message; });
      });
    };
    document.getElementById('loginBtn').onclick = submit;
    // NEW: Enter key submits the login form.
    ['loginEmail','loginPassword'].forEach(function(id){
      document.getElementById(id).onkeydown = function(e){ if (e.key === 'Enter') submit(); };
    });
  },
  hideLogin: function() { document.getElementById('loginOverlay').style.display='none'; document.getElementById('appLayout').classList.add('active'); },

  // FIX: logout now invalidates the token on the server too.
  logout: function(localOnly) {
    var s = this, pending = ISSApi.pendingCount();
    if (!localOnly && pending > 0 && !s._logoutConfirmed) {
      s.modal.show('⚠️ Changes not yet sent',
        '<b>' + pending + '</b> change' + (pending === 1 ? '' : 's') + ' made on this device ' + (pending === 1 ? 'has' : 'have') + ' not reached the server yet.<br><br>' +
        'If you log out now ' + (pending === 1 ? 'it stays' : 'they stay') + ' safely on this device and ' + (pending === 1 ? 'is' : 'are') + ' sent the next time you sign in here.',
        [{text:'Cancel',cls:'btn-secondary'},
         {text:'🔄 Send now',cb:function(){ ISSApi.flush(); }},
         {text:'Log out anyway',cls:'btn-danger',cb:function(){ s._logoutConfirmed=true; setTimeout(function(){ s.logout(); s._logoutConfirmed=false; },0); }}]);
      return;
    }
    var tok = this.token, email = this.user && this.user.email;
    if (tok && !localOnly) ISSApi.call('logoutUser', { token: tok }).catch(function(){});
    if (email && !localOnly) ISSApi.clearUserCache(email);   // saved screens are private to the signed-in user
    this.token = ''; this.user = null;
    this._cache = { classes:null,students:null,studentIdx:null,config:null,crest:this._cache.crest,expenses:null,expCats:null };
    this._feeOvData = [];
    this._resetPagination();
    this._clearSession();
    if (window.ISSSync) ISSSync.onSessionEnd();
    this.closePrint(); this.modal.close();
    this.toggleNav(false);
    var bn=document.getElementById('bottomNav'); bn.classList.remove('show'); bn.innerHTML='';
    document.getElementById('appLayout').classList.remove('active');
    document.getElementById('loginOverlay').style.display='flex';
    document.getElementById('loginEmail').value=''; document.getElementById('loginPassword').value=''; document.getElementById('loginError').textContent='';
    this.showLogin();
  },

  /* ── Light / dark mode (remembered on this device) ── */
  theme: function(){ return document.documentElement.getAttribute('data-theme')==='light'?'light':'dark'; },
  setTheme: function(t, remember){
    document.documentElement.setAttribute('data-theme', t==='light'?'light':'dark');
    if (remember!==false) { try { localStorage.setItem('iss-theme', t); } catch(e){} }
    this.paintThemeButtons();
  },
  toggleTheme: function(){ this.setTheme(this.theme()==='light'?'dark':'light'); },
  paintThemeButtons: function(){
    var light=this.theme()==='light';
    document.querySelectorAll('.theme-btn').forEach(function(b){
      // The button shows what you will switch TO.
      b.textContent = b.id==='themeSideBtn' ? (light?'🌙 Dark mode':'☀️ Light mode') : (light?'🌙':'☀️');
      b.setAttribute('aria-label', light?'Switch to dark mode':'Switch to light mode');
    });
    var m=document.querySelector('meta[name="theme-color"]'); if (m) m.content=light?'#ffffff':'#152230';
  },
  // Phones: up to four of the user's most-used pages plus "More" (opens the full menu).
  BOTTOM_NAV: [['dashboard','Home'],['fees','Fees'],['canteen','Canteen'],['attendance','Attendance'],['results','Results'],
               ['students','Students'],['payroll','Payroll'],['expenses','Expenses'],['finances','Finances'],['report','Reports']],
  buildBottomNav: function(){
    var s=this, nav=document.getElementById('bottomNav'), allowed=(s.user&&s.user.allowedPages)||[];
    var picks=s.BOTTOM_NAV.filter(function(p){ return allowed.indexOf(p[0])>=0 && s.pages[p[0]]; }).slice(0,4);
    nav.innerHTML='';
    picks.forEach(function(p){
      var b=document.createElement('button'); b.type='button'; b.dataset.page=p[0];
      b.innerHTML='<span class="bn-ic">'+s.pages[p[0]].icon+'</span><span class="bn-tx">'+p[1]+'</span>';
      b.onclick=function(){ s.switchPage(p[0]); }; nav.appendChild(b);
    });
    {   // always present: the full menu also holds Change Password and Logout
      var m=document.createElement('button'); m.type='button'; m.dataset.page='__more';
      m.innerHTML='<span class="bn-ic">☰</span><span class="bn-tx">More</span>';
      m.onclick=function(){ s.toggleNav(true); }; nav.appendChild(m);
    }
    nav.classList.toggle('show', nav.children.length>0);
  },
  initSidebar: function() {
    var s=this, menu=document.getElementById('navMenu'); menu.innerHTML='';
    (s.user.allowedPages || []).forEach(function(k) {
      if (!s.pages[k]) return;
      var d=document.createElement('div'); d.className='nav-item'; d.dataset.page=k;
      d.innerHTML='<span>'+s.pages[k].icon+'</span> '+k.charAt(0).toUpperCase()+k.slice(1);
      d.onclick=function(){ s.switchPage(k); }; menu.appendChild(d);
    });
    s.buildBottomNav();
    document.getElementById('sidebarUser').textContent = s.user.name+' ('+s.user.role+')';
    if (s._cache.crest) s.setCrest(s._cache.crest);
    else s.call('getSchoolCrest',{},'crest').then(function(c){ s.setCrest(c); });
    s.getConfig().then(function(c){ document.getElementById('sidebarSchoolName').textContent=(c&&c.schoolName)||'iSmartSchool'; }).catch(function(){});
  },

  // NEW: the backend had changePassword() but no screen used it.
  showChangePassword: function() {
    var s = this;
    s.modal.show('🔑 Change Password',
      '<input id="cpCur" class="form-control" type="password" placeholder="Current password">' +
      '<input id="cpNew" class="form-control" type="password" placeholder="New password (min 6 characters)">' +
      '<input id="cpNew2" class="form-control" type="password" placeholder="Confirm new password">' +
      '<div id="cpErr" style="color:var(--red);font-size:13px;min-height:18px;margin-top:6px;"></div>',
      [{text:'Cancel',cls:'btn-secondary'},{text:'Save',cb:function(){
        var cur=document.getElementById('cpCur').value, n1=document.getElementById('cpNew').value, n2=document.getElementById('cpNew2').value, err=document.getElementById('cpErr');
        if (!cur||!n1) { err.textContent='Please fill all fields.'; return false; }
        if (n1.length<6) { err.textContent='New password must be at least 6 characters.'; return false; }
        if (n1!==n2) { err.textContent='New passwords do not match.'; return false; }
        err.textContent='Saving…';
        s.call('changePassword',{currentPassword:cur,newPassword:n1}).then(function(r){
          if (r.success) { s.modal.close(); s.modal.alert('✅ '+r.message); } else { err.textContent='❌ '+r.message; }
        }).catch(function(e){ err.textContent='❌ '+e.message; });
        return false;
      }}]);
  },

  setCrest: function(src) {
    this._cache.crest=src||'';
    var html=src?'<img src="'+this.escapeHtml(src)+'" alt="">':'🏫';
    document.getElementById('sidebarCrest').innerHTML=html;
    document.getElementById('mobileCrest').innerHTML=html;
  },
  // Phone/tablet slide-out menu
  toggleNav: function(open) {
    var sb=document.getElementById('sidebar'), bd=document.getElementById('navBackdrop'), btn=document.getElementById('menuBtn');
    var on = open===undefined ? !sb.classList.contains('open') : !!open;
    sb.classList.toggle('open', on); bd.classList.toggle('show', on);
    btn.setAttribute('aria-expanded', on?'true':'false');
    document.body.style.overflow = on ? 'hidden' : '';
  },

  switchPage: function(page) {
    var s=this;
    s.toggleNav(false);
    if (s.user && s.user.allowedPages && s.user.allowedPages.indexOf(page) < 0) page = s.user.allowedPages[0];
    document.querySelectorAll('.nav-item').forEach(function(e){ e.classList.toggle('active', e.dataset.page === page); });
    var inBar=false;
    document.querySelectorAll('#bottomNav button').forEach(function(e){ var on=e.dataset.page===page; if(on) inBar=true; e.classList.toggle('active', on); });
    var more=document.querySelector('#bottomNav button[data-page="__more"]'); if (more && !inBar) more.classList.add('active');
    document.getElementById('pageTitle').textContent = page.charAt(0).toUpperCase()+page.slice(1);
    document.getElementById('mobileTitle').textContent = (s.pages[page]?s.pages[page].icon+' ':'')+page.charAt(0).toUpperCase()+page.slice(1);
    window.scrollTo(0,0);
    // Each visit gets its own container: if a slower load from the page the
    // user just left finishes later, it fills a detached element instead of
    // replacing the page now on screen.
    var host=document.getElementById('pageBody'); host.innerHTML='';
    var b=document.createElement('div'); b.className='page-view'; b.innerHTML=s.spinner; host.appendChild(b);
    var map={
      dashboard:function(){ s.loadDashboard(b); }, students:function(){ s.loadStudents(b); },
      fees:function(){ s.loadFeePage(b); }, canteen:function(){ s.loadCanteen(b); }, finances:function(){ s.loadFinances(b); },
      expenses:function(){ s.loadExpenses(b); }, payroll:function(){ s.loadPayroll(b); }, results:function(){ s.loadResults(b); },
      report:function(){ s.loadReport(b); }, attendance:function(){ s.loadAttendance(b); },
      promotion:function(){ s.loadPromotion(b); }, settings:function(){ s.loadSettings(b); },
      curriculum:function(){ s.loadCurriculum(b); }
    };
    if (map[page]) map[page](); else b.innerHTML='<p style="color:var(--text-muted);text-align:center;padding:40px;">Page ready</p>';
  },

  /* ═══ DASHBOARD ═══ */
  loadDashboard: function(el) {
    var s = this;
    s.call('getDashboardStats').then(function(d) {
      var defs = [['totalStudents','Students','var(--green)'],['maleCount','Male','var(--red)'],['femaleCount','Female','var(--blue)'],
                  ['finalClassCount',(d.finalClassCode||'Final class')+' (final class)','var(--purple)']];
      if (s.hasPage('fees')) defs.push(['todayCollection','Today Fees','var(--gold)']);
      if (s.hasPage('expenses')) defs.push(['todayExpenses','Today Expense','var(--teal)']);
      var showArch=d.archiveDue && !s._archSnoozed;
      el.innerHTML = (showArch?'<div id="archBanner" style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;background:var(--gold-bg);border:1px solid rgba(255,193,7,.35);color:var(--gold);padding:12px 16px;border-radius:12px;margin-bottom:16px;"><span id="archMsg">🗄️ Last term\'s records have not been archived yet. Archiving keeps the system fast.</span><span style="display:flex;gap:8px;"><button class="btn btn-gold" id="archiveNowBtn" style="margin:0;padding:8px 16px;">Archive now</button><button class="btn btn-secondary" id="archiveLaterBtn" style="margin:0;padding:8px 14px;">Later</button></span></div>':'')+
        '<p style="color:var(--text-muted);margin-bottom:16px;">'+s.escapeHtml(s.TERM_NAMES[d.term]||('Term '+d.term))+' — '+s.escapeHtml(d.academicYear)+'</p>'+
        '<div class="stats-grid">'+ defs.map(function(def){
          var val=d[def[0]], display=/^today/.test(def[0])?s.money(val):s.escapeHtml(val);
          return '<div class="stat-card"><div class="stat-value" style="color:'+def[2]+'">'+display+'</div><div class="stat-label">'+s.escapeHtml(def[1])+'</div></div>';
        }).join('')+'</div>'+s._quickActionsHtml();
      el.querySelectorAll('[data-qa]').forEach(function(b){ b.onclick=function(){ s._runQuickAction(b.dataset.qa); }; });
      if (showArch) {
        document.getElementById('archiveLaterBtn').onclick=function(){ s._archSnoozed=true; var b=document.getElementById('archBanner'); if (b) b.remove(); };
        document.getElementById('archiveNowBtn').onclick=function(){ s._archiveFromBanner(el); };
      }
    }).catch(function(e){ el.innerHTML=s.errHtml(e); });
  },

  // Runs the archive right from the dashboard reminder and re-checks afterwards.
  _archiveFromBanner: function(el){
    var s=this, msg=document.getElementById('archMsg'), btns=document.getElementById('archiveNowBtn').parentNode;
    s.modal.confirm('Move last term\'s attendance, results, conduct, fee overrides and canteen rows into the archive spreadsheet now?<br><small style="color:var(--text-muted);">Nothing on screen changes. Archived dates can no longer be edited. Best done when few people are using the system.</small>').then(function(ok){
      if (!ok) return;
      btns.style.display='none';
      s.runArchive(function(t){ msg.textContent=t; }).then(function(moved){
        return s.call('getArchiveStatus').then(function(st){
          if (!st.due) { msg.textContent='✅ Archive complete — '+Number(moved).toLocaleString()+' rows moved.'; setTimeout(function(){ s.loadDashboard(el); }, 1500); return; }
          msg.innerHTML='⚠️ Archived '+Number(moved).toLocaleString()+' rows, but some are left: '+s.escapeHtml(st.left.map(function(x){ return x.sheet.replace(/_/g,' ')+' ('+x.rows+')'; }).concat(st.pending).join(', '))+'. Click Archive now again.';
          btns.style.display='';
        });
      }).catch(function(e){ msg.textContent='❌ '+e.message+' — click Archive now again to continue; nothing is lost.'; btns.style.display=''; });
    });
  },

  // Dashboard shortcuts to the everyday tasks this user is allowed to do.
  QUICK_ACTIONS: [
    ['pay','💳','Record a payment','fees'], ['canteen','🍽️','Canteen register','canteen'], ['attendance','📅','Take attendance','attendance'],
    ['scores','📝','Enter scores','results'], ['student','➕','Add a student','students','students.edit'], ['expense','💸','Record an expense','expenses'],
    ['payroll','🧑‍💼','Payroll','payroll'], ['report','📄','Report cards','report']
  ],
  _quickActionsHtml: function(){
    var s=this, list=s.QUICK_ACTIONS.filter(function(q){ return s.hasPage(q[3]) && (!q[4] || s.can(q[4])); }).slice(0,6);
    if (!list.length) return '';
    return '<h3 style="margin:4px 0 12px;font-size:16px;">Quick actions</h3><div class="quick-actions">'+
      list.map(function(q){ return '<button type="button" class="qa-tile" data-qa="'+q[0]+'"><span class="qa-ic">'+q[1]+'</span><span>'+s.escapeHtml(q[2])+'</span></button>'; }).join('')+'</div>';
  },
  _runQuickAction: function(key){
    var s=this, q=s.QUICK_ACTIONS.find(function(x){ return x[0]===key; }); if (!q) return;
    s.switchPage(q[3]);
    var clickWhenReady=function(id){ var n=0, t=setInterval(function(){ var b=document.getElementById(id); if (b || ++n>40) { clearInterval(t); if (b) b.click(); } }, 150); };
    if (key==='student') clickWhenReady('addStudentBtn');
    if (key==='expense') clickWhenReady('addExpBtn');
  },

  /* ═══ STUDENTS ═══ */
  loadStudents: function(el) {
    var s=this, canManage=s.canManageStudents(), canDelete=s.can('students.delete');
    s.getClasses().then(function(cl) {
      el.innerHTML=
        '<div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">'+
          '<select id="stClassFilter" class="form-control" style="width:auto;">'+s.classOptions(cl,true,s._stFilter)+'</select>'+
          '<input id="stSearch" class="form-control" placeholder="Search name / ID / parent…" style="flex:1;min-width:180px;" value="'+s.escapeHtml(s._stSearch)+'">'+
          (canManage?'<button class="btn" id="addStudentBtn">+ Add Student</button>':'')+
          (canManage?'<button class="btn btn-secondary" id="bulkUploadBtn">📎 Bulk CSV</button>':'')+
          (canDelete?'<button class="btn" id="showInactiveBtn" style="background:var(--purple);">👁️ Inactive Students</button>':'')+
          (canManage?'<a href="#" id="csvTplLink" style="color:var(--green);align-self:center;">📥 Template</a>':'')+
        '</div>'+
        '<div id="studentForm" class="hidden" style="background:var(--bg-secondary);border-radius:16px;padding:20px;margin-bottom:16px;"></div>'+
        '<div id="bulkForm" class="hidden" style="margin:15px 0;padding:20px;background:var(--bg-secondary);border-radius:16px;">'+
          '<h4>Import from CSV</h4>'+
          '<p style="color:var(--text-muted);font-size:13px;">Columns: FullName, Gender, DateOfBirth, Class, AdmissionDate, ResidentialAddress, ParentName, ParentMoMo. Class must match a class code (e.g. B1).</p>'+
          '<input type="file" id="bulkCsvFile" class="form-control" accept=".csv" style="margin-top:10px;">'+
          '<button class="btn" id="uploadBulkBtn">🚀 Upload &amp; Import</button>'+
          '<div id="bulkResult" style="margin-top:10px;font-size:13px;"></div>'+
        '</div>'+
        '<div id="stTableWrap"></div>';
      document.getElementById('stClassFilter').onchange = function(){ s._stFilter=this.value; s._stPage=1; s._renderStudentTable(); };
      document.getElementById('stSearch').addEventListener('input', s.debounce(function(){ s._stSearch=this.value.toLowerCase(); s._stPage=1; s._renderStudentTable(); }, 250));
      if (canManage) document.getElementById('addStudentBtn').onclick = function(){ s.showStudentForm(); };
      if (canManage) {
        document.getElementById('bulkUploadBtn').onclick   = function(){ document.getElementById('bulkForm').classList.toggle('hidden'); };
        document.getElementById('csvTplLink').onclick      = function(e){ e.preventDefault(); s.downloadCsvTemplate(); };
        document.getElementById('uploadBulkBtn').onclick   = function(){ s.uploadBulkStudents(); };
      }
      if (canDelete) document.getElementById('showInactiveBtn').onclick = function(){ s._showInactiveStudents(); };
      document.getElementById('stTableWrap').innerHTML = s.spinner;
      s.getStudents().then(function(list){ s._stData=list; s._renderStudentTable(); })
        .catch(function(e){ document.getElementById('stTableWrap').innerHTML=s.errHtml(e); });
    }).catch(function(e){ el.innerHTML=s.errHtml(e); });
  },
  _reloadStudents: function() {
    var s=this; s.invalidateStudents();
    return s.getStudents().then(function(list){ s._stData=list; if (document.getElementById('stTableWrap')) s._renderStudentTable(); });
  },
  _renderStudentTable: function() {
    var s=this, data=s._stData, canManage=s.canManageStudents(), canDelete=s.can('students.delete');
    if (s._stFilter && s._stFilter!=='All') data=data.filter(function(st){ return st.Class===s._stFilter; });
    if (s._stSearch) { var q=s._stSearch; data=data.filter(function(st){ return String(st.FullName||'').toLowerCase().includes(q)||String(st.StudentID||'').toLowerCase().includes(q)||String(st.ParentName||'').toLowerCase().includes(q); }); }
    var total=data.length, pages=Math.max(1,Math.ceil(total/s.PAGE_SIZE));
    s._stPage=Math.min(s._stPage,pages);
    var start=(s._stPage-1)*s.PAGE_SIZE, slice=data.slice(start,start+s.PAGE_SIZE);
    var wrap=document.getElementById('stTableWrap'); wrap.innerHTML='';
    if (!total) { wrap.innerHTML='<p style="color:var(--text-muted);text-align:center;padding:30px;">No students found.</p>'; return; }
    var headers=['ID','Name','Class','Gender','Parent','Phone']; if (canManage||canDelete) headers.push('Actions');
    var rows=slice.map(function(st){
      var tr=document.createElement('tr');
      [st.StudentID,st.FullName,st.Class,st.Gender,st.ParentName,st.ParentMoMo].forEach(function(v){ tr.insertCell().textContent=v||''; });
      if (canManage||canDelete) {
        var td=tr.insertCell();
        if (canManage) {
          td.appendChild(s._btn('Edit','',function(){ s.showStudentForm(st.StudentID); }));
          tr.style.cursor='pointer'; tr.title='Tap to edit';
          tr.onclick=function(e){ if (!e.target.closest('button')) { s.showStudentForm(st.StudentID); var f=document.getElementById('studentForm'); if (f) f.scrollIntoView({behavior:'smooth',block:'start'}); } };
        }
        if (canDelete) td.appendChild(s._btn('Del','btn-danger',function(){ s.deleteStudent(st.StudentID, st.FullName); },canManage?'margin-left:4px;':''));
      }
      return tr;
    });
    wrap.appendChild(s._buildTable(headers,rows));
    if (pages>1) wrap.appendChild(s._buildPagination(s._stPage,pages,total,start,function(p){ s._stPage=p; s._renderStudentTable(); }));
  },
  _showInactiveStudents: function() {
    var s = this;
    s.modal.show('👁️ Inactive Students', '<div id="inactiveListWrap">' + s.spinner + '</div>', [{ text: 'Close', cls: 'btn-secondary' }]);
    s.call('getAllStudentsIncludingInactive').then(function(list) {
      var wrap = document.getElementById('inactiveListWrap'); if (!wrap) return;
      var inactive = (list || []).filter(function(st) { return String(st.Status || '').toLowerCase() === 'inactive'; });
      if (!inactive.length) { wrap.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">No inactive students.</p>'; return; }
      var rows = inactive.map(function(st) {
        var tr = document.createElement('tr');
        [st.StudentID, st.FullName, st.Class].forEach(function(v) { tr.insertCell().textContent = v || ''; });
        var btn = s._btn('✅ Reactivate', '', null);
        btn.onclick = function() {
          s.safeSubmit(btn, function() {
            return s.call('reactivateStudent', { sid: st.StudentID }).then(function(r) {
              if (r.success) { tr.style.opacity='0.4'; btn.textContent='✅ Done'; setTimeout(function(){ btn.disabled=true; },0); s._reloadStudents(); }
              else { s.modal.alert('❌ '+r.message); }
            });
          });
        };
        tr.insertCell().appendChild(btn); return tr;
      });
      wrap.innerHTML=''; wrap.appendChild(s._buildTable(['ID','Name','Class','Action'], rows));
    }).catch(function(e) { var wrap=document.getElementById('inactiveListWrap'); if(wrap) wrap.innerHTML=s.errHtml(e); });
  },
  showStudentForm: function(sid) {
    var s=this, f=document.getElementById('studentForm'), isE=!!sid;
    f.classList.remove('hidden'); f.innerHTML=s.spinner;
    var idemKey=isE?null:s.newIdemKey();     // same key on every retry → never a second student
    Promise.all([isE?s.getStudentCached(sid):Promise.resolve({}), s.getClasses(), isE?Promise.resolve({}):s.getConfig().catch(function(){ return {}; })]).then(function(res){
      var admDefault=parseFloat((res[2]||{}).admissionFee)||0;
      var st=res[0]||{}, cl=res[1], E=function(v){ return s.escapeHtml(v||''); };
      var sc='None', ca='';
      if (st.Scholarship) { if (String(st.Scholarship)==='Full') sc='Full'; else if (String(st.Scholarship)!=='None') { sc='Partial'; ca=st.Scholarship; } }
      f.innerHTML='<h3 style="margin-bottom:15px;">'+(isE?'Edit Student':'New Student')+'</h3>'+
        '<div class="two-col" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">'+
          '<div><label>Full Name *</label><input id="sFullName" class="form-control" value="'+E(st.FullName)+'"></div>'+
          '<div><label>Gender</label><select id="sGender" class="form-control"><option'+(st.Gender==='Male'?' selected':'')+'>Male</option><option'+(st.Gender==='Female'?' selected':'')+'>Female</option></select></div>'+
          '<div><label>Date of Birth</label><input id="sDOB" class="form-control" type="date" value="'+E(st.DateOfBirth)+'"></div>'+
          '<div><label>Class *</label><select id="sClass" class="form-control">'+s.classOptions(cl,false,st.Class)+'</select></div>'+
          '<div><label>Admission Date</label><input id="sAdm" class="form-control" type="date" value="'+E(st.AdmissionDate||s.todayYMD())+'"></div>'+
          '<div><label>Address</label><input id="sAddr" class="form-control" value="'+E(st.ResidentialAddress)+'"></div>'+
          '<div><label>Parent Name</label><input id="sParent" class="form-control" value="'+E(st.ParentName)+'"></div>'+
          '<div><label>Parent Phone / MoMo</label><input id="sPhone" class="form-control" inputmode="tel" value="'+E(st.ParentMoMo)+'"></div>'+
          '<div><label>Emergency Contact</label><input id="sEmerg" class="form-control" inputmode="tel" value="'+E(st.EmergencyContact)+'"></div>'+
          '<div><label>Previous School</label><input id="sPrev" class="form-control" value="'+E(st.PreviousSchool)+'"></div>'+
        '</div>'+
        '<div style="margin-top:10px;"><label>Medical Conditions</label><input id="sMed" class="form-control" value="'+E(st.MedicalConditions)+'"></div>'+
        (isE?'<div style="margin-top:10px;"><label>Photo (shown on report cards)</label><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;"><input type="file" id="sPhoto" class="form-control" accept="image/*" style="flex:1;min-width:180px;"><button class="btn btn-secondary" id="sPhotoBtn" style="margin:0;">📷 Upload photo</button></div></div>':'<p style="color:var(--text-muted);font-size:12px;margin-top:8px;">You can add a photo after saving, using Edit.</p>')+
        '<div style="margin-top:10px;"><label>Scholarship</label>'+
          '<select id="sSch" class="form-control"><option value="None"'+(sc==='None'?' selected':'')+'>None</option><option value="Full"'+(sc==='Full'?' selected':'')+'>Full</option><option value="Partial"'+(sc==='Partial'?' selected':'')+'>Partial</option></select></div>'+
        '<div id="sSchGrp" style="display:'+(sc==='Partial'?'block':'none')+';margin-top:10px;"><label>Amount the student pays per term (GH₵)</label><input id="sSchAmt" class="form-control" type="number" step="0.01" min="0" value="'+E(ca)+'"></div>'+
        (!isE?'<div style="margin-top:12px;padding:12px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;">'+
          '<label style="display:flex;gap:8px;align-items:center;color:var(--text-primary);font-weight:600;cursor:pointer;"><input type="checkbox" id="sNewAdm" checked style="width:18px;height:18px;"> New admission — charge the one-time admission fee</label>'+
          '<div id="sAdmWrap" style="margin-top:8px;"><label>Admission fee (GH₵)</label><input id="sAdmFee" class="form-control" type="number" step="0.01" min="0" value="'+admDefault.toFixed(2)+'"></div>'+
          '<p style="font-size:12px;color:var(--text-muted);margin-top:6px;">Untick for a pupil who is already in the school and is only being entered into the system — no admission fee is charged.</p></div>':'')+
        '<div id="sErr" style="color:var(--red);font-size:13px;min-height:18px;margin-top:8px;"></div>'+
        '<div><button class="btn" id="saveStudentBtn">💾 Save</button> <button class="btn btn-secondary" id="cancelStudentBtn">Cancel</button></div>';
      document.getElementById('cancelStudentBtn').onclick=function(){ s.hideStudentForm(); };
      if (isE) document.getElementById('sPhotoBtn').onclick=function(){
        var f=document.getElementById('sPhoto').files[0]; if (!f) { s.modal.alert('Choose a photo first.'); return; }
        s.safeSubmit(this, function(){
          // Small passport-size image keeps the sheet light and loads fast.
          return s.resizeImage(f,180).then(function(b64){
            return s.call('uploadStudentPhoto',{sid:sid,photo:b64}).then(function(r){ s.modal.alert(r.success?'✅ Photo saved.':'❌ '+r.message); });
          });
        });
      };
      document.getElementById('sSch').onchange=function(){ document.getElementById('sSchGrp').style.display=this.value==='Partial'?'block':'none'; };
      document.getElementById('saveStudentBtn').onclick=function(){
        var err=document.getElementById('sErr'); err.textContent='';
        var name=document.getElementById('sFullName').value.trim();
        if (!name) { err.textContent='Full name is required.'; return; }
        if (!document.getElementById('sClass').value) { err.textContent='Please choose a class.'; return; }
        var sch=document.getElementById('sSch').value;
        if (sch==='Partial') { var cv=parseFloat(document.getElementById('sSchAmt').value); if (isNaN(cv)||cv<0) { err.textContent='Enter a valid scholarship amount.'; return; } sch=String(cv); }
        var payload={
          studentID:isE?sid:null, fullName:name, gender:document.getElementById('sGender').value,
          dateOfBirth:document.getElementById('sDOB').value, class:document.getElementById('sClass').value,
          admissionDate:document.getElementById('sAdm').value, address:document.getElementById('sAddr').value,
          parentName:document.getElementById('sParent').value, parentMoMo:document.getElementById('sPhone').value.trim(),
          emergencyContact:document.getElementById('sEmerg').value.trim(), previousSchool:document.getElementById('sPrev').value,
          medicalConditions:document.getElementById('sMed').value, scholarship:sch,
          newAdmission:!isE&&document.getElementById('sNewAdm').checked,
          admissionFee:!isE?(parseFloat(document.getElementById('sAdmFee').value)||0):0,
          idempotencyKey:idemKey
        };
        var btn=this;
        var send=function(){ s.safeSubmit(btn, function(){
          return s.call(isE?'updateStudent':'addStudent',payload).then(function(res){
            if (!res.success && res.possibleDuplicate) {
              s.modal.show('Possible duplicate', s.escapeHtml(res.message)+'<br><br>Add <b>'+s.escapeHtml(payload.fullName)+'</b> as a different student anyway?',
                [{text:'Cancel',cls:'btn-secondary'},{text:'Yes, add',cb:function(){ payload.confirmDuplicate=true; setTimeout(send,0); }}]);
              return;
            }
            if (!res.success) { err.textContent='❌ '+res.message; return; }
            s._feeOvData=[];
            return s.modal.alert(res.message + (res.studentID ? ' (ID: '+res.studentID+')' : '')).then(function(){ s.hideStudentForm(); s._reloadStudents(); });
          });
        }); };
        send();
      };
      if (!isE) document.getElementById('sNewAdm').onchange=function(){ document.getElementById('sAdmWrap').style.display=this.checked?'':'none'; };
    }).catch(function(e){ f.innerHTML=s.errHtml(e); });
  },
  hideStudentForm: function(){ var f=document.getElementById('studentForm'); if (f) { f.classList.add('hidden'); f.innerHTML=''; } },
  deleteStudent: function(sid, name) {
    var s = this;
    s.modal.show('<span style="color:var(--red)">⚠️ Remove Student</span>',
      'What would you like to do with <b>'+s.escapeHtml(name||sid)+'</b>?',
      [{text:'🗑️ Permanently Delete',cls:'btn-danger',cb:function(){
         setTimeout(function(){
           s.modal.confirm('⚠️ <b>PERMANENTLY DELETE</b> '+s.escapeHtml(name||sid)+' and ALL their fee, result and attendance records?<br><br>This <b>cannot be undone</b>.').then(function(ok){
             if (!ok) return;
             s.call('deleteStudent',{sid:sid,confirmDelete:true}).then(function(r){
               s.modal.alert((r.success?'✅ ':'❌ ')+r.message).then(function(){ if (r.success) { s._feeOvData=[]; s._reloadStudents(); } });
             }).catch(function(e){ s.modal.alert('Error: '+e.message); });
           });
         },0);
       }},
       {text:'⏸️ Deactivate',cls:'btn-gold',cb:function(){
         setTimeout(function(){
           s.modal.confirm('Deactivate '+s.escapeHtml(name||sid)+'? They will be hidden but their data is preserved.').then(function(ok){
             if (!ok) return;
             s.call('deactivateStudent',{sid:sid}).then(function(r){
               s.modal.alert((r.success?'✅ ':'❌ ')+r.message).then(function(){ if (r.success) { s._feeOvData=[]; s._reloadStudents(); } });
             }).catch(function(e){ s.modal.alert('Error: '+e.message); });
           });
         },0);
       }},
       {text:'Cancel',cls:'btn-secondary'}]);
  },
  downloadCsvTemplate: function(){
    var csv='FullName,Gender,DateOfBirth,Class,AdmissionDate,ResidentialAddress,ParentName,ParentMoMo,EmergencyContact,PreviousSchool,Scholarship\nJohn Doe,Male,2015-05-12,B1,2026-01-01,"123 Main Street",Jane Doe,0244123456,,,None';
    var url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    var a=document.createElement('a'); a.href=url; a.download='student_bulk_template.csv'; a.click(); URL.revokeObjectURL(url);
  },
  // FIX: failures used to show a green "✅ 0 students added".
  uploadBulkStudents: function(){
    var s=this, f=document.getElementById('bulkCsvFile').files[0], out=document.getElementById('bulkResult');
    if (!f){ s.modal.alert('Please select a CSV file'); return; }
    var b=document.getElementById('uploadBulkBtn'); b.disabled=true; b.textContent='Uploading…'; out.innerHTML='';
    var reader=new FileReader();
    reader.onload=function(e){
      s.call('bulkUploadStudents',{fileContent:e.target.result}).then(function(res){
        var skipped=(res.skipped||[]);
        out.innerHTML='<div style="color:'+(res.success?'var(--green)':'var(--red)')+'">'+(res.success?'✅ ':'❌ ')+s.escapeHtml(res.message)+'</div>'+
          (skipped.length?'<ul style="color:var(--gold);margin:8px 0 0 18px;">'+skipped.slice(0,20).map(function(x){ return '<li>'+s.escapeHtml(x)+'</li>'; }).join('')+(skipped.length>20?'<li>…and '+(skipped.length-20)+' more</li>':'')+'</ul>':'');
        if (res.success) s._reloadStudents();
      }).catch(function(ex){ out.innerHTML='<span style="color:var(--red)">❌ '+s.escapeHtml(ex.message)+'</span>'; })
        .then(function(){ b.disabled=false; b.textContent='🚀 Upload & Import'; });
    };
    reader.onerror=function(){ s.modal.alert('Error reading file'); b.disabled=false; b.textContent='🚀 Upload & Import'; };
    reader.readAsText(f);
  },

  /* ═══ FEES ═══ */
  loadFeePage: function(el){
    var s=this;
    Promise.all([s.getClasses(),s.getStudents()]).then(function(res){
      var cl=res[0], students=res[1], classOpts=s.classOptions(cl,true);
      el.innerHTML=
        '<div class="tab-bar">'+
          '<button class="btn tab-btn active" data-ftab="overview">💳 Make Payment</button>'+
          (s.can('fees.adjust')?'<button class="btn tab-btn" data-ftab="individual">✏️ Edit Fees</button>':'')+
          '<button class="btn tab-btn" data-ftab="history">📜 Payment History</button>'+
        '</div>'+
        '<div id="feeIndividualPanel" style="display:none;">'+
          '<div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;">'+
            '<select id="feeClassFilter" class="form-control" style="width:auto;">'+classOpts+'</select>'+
            '<select id="feeStudentSelect" class="form-control" style="flex:1;">'+s.studentOptions(students,'All','Select student')+'</select>'+
            '<button class="btn" id="loadFeeBtn" style="margin-top:5px;">Load</button>'+
          '</div><div id="feeDetails"></div>'+
        '</div>'+
        '<div id="feeHistoryPanel" style="display:none;">'+
          '<div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;">'+
            '<select id="histClassFilter" class="form-control" style="width:auto;">'+classOpts+'</select>'+
            '<select id="histStudentSelect" class="form-control" style="flex:1;">'+s.studentOptions(students,'All','Select student')+'</select>'+
            '<button class="btn" id="loadHistBtn" style="margin-top:5px;">Load History</button>'+
          '</div><div id="histDetails"><div style="text-align:center;padding:40px;color:var(--text-muted);">Select a student, then click <b>Load History</b>.</div></div>'+
        '</div>'+
        '<div id="feeOverviewPanel">'+
          '<div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">'+
            '<select id="ovClassFilter" class="form-control" style="width:auto;min-width:160px;">'+classOpts+'<option value="GRADUATED">Graduated (arrears)</option></select>'+
            '<select id="ovStatusFilter" class="form-control" style="width:auto;"><option value="All">All Statuses</option><option value="Full">Fully Paid</option><option value="Partial">Partial</option><option value="Not Paid">Not Paid</option></select>'+
            '<input id="ovSearch" class="form-control" placeholder="Search name or ID…" style="flex:1;min-width:160px;">'+
            '<button class="btn btn-secondary" id="ovRefreshBtn" style="margin-top:5px;">🔄 Refresh</button>'+
            '<button class="btn btn-secondary" id="ovExportBtn" style="margin-top:5px;">📥 Export CSV</button>'+
          '</div><div id="ovSummaryBar"></div><div id="ovTableWrap"></div>'+
        '</div>';
      var panels={overview:'feeOverviewPanel',individual:'feeIndividualPanel',history:'feeHistoryPanel'};
      el.querySelectorAll('[data-ftab]').forEach(function(btn){
        btn.onclick=function(){
          el.querySelectorAll('[data-ftab]').forEach(function(b){ b.classList.toggle('active', b===btn); });
          Object.keys(panels).forEach(function(k){ document.getElementById(panels[k]).style.display = k===btn.dataset.ftab?'':'none'; });
          if (btn.dataset.ftab==='overview') s._renderFeeOverviewTable();
        };
      });
      document.getElementById('feeClassFilter').onchange=function(){ document.getElementById('feeStudentSelect').innerHTML=s.studentOptions(students,this.value,'Select student'); };
      document.getElementById('loadFeeBtn').onclick=function(){ var sid=document.getElementById('feeStudentSelect').value; if(sid) s._loadStudentFeeEditOnly(sid); else s.modal.alert('Select a student first.'); };
      document.getElementById('histClassFilter').onchange=function(){ document.getElementById('histStudentSelect').innerHTML=s.studentOptions(students,this.value,'Select student'); };
      document.getElementById('loadHistBtn').onclick=function(){ var sid=document.getElementById('histStudentSelect').value; if(sid) s._loadStudentPaymentHistory(sid); else s.modal.alert('Select a student first.'); };
      // FIX: filters/search/export used to lose their handlers when the page
      // was revisited with cached data. They're now bound on every load.
      s._feeOvPage=1; s._feeOvClass='All'; s._feeOvStatus='All'; s._feeOvSearch='';
      document.getElementById('ovClassFilter').onchange = function(){ s._feeOvClass=this.value; s._feeOvPage=1; s._renderFeeOverviewTable(); };
      document.getElementById('ovStatusFilter').onchange = function(){ s._feeOvStatus=this.value; s._feeOvPage=1; s._renderFeeOverviewTable(); };
      document.getElementById('ovSearch').addEventListener('input', s.debounce(function(){ s._feeOvSearch=this.value.toLowerCase(); s._feeOvPage=1; s._renderFeeOverviewTable(); }, 250));
      document.getElementById('ovExportBtn').onclick = function(){ s._exportFeeOverviewCSV(); };
      document.getElementById('ovRefreshBtn').onclick = function(){ s._reloadFeeOverview(); };
      s._reloadFeeOverview();
    }).catch(function(e){ el.innerHTML=s.errHtml(e); });
  },
  _feeOvData: [], _feeOvPage: 1, _feeOvClass: 'All', _feeOvStatus: 'All', _feeOvSearch: '',
  _reloadFeeOverview: function(){
    var s=this, wrap=document.getElementById('ovTableWrap'); if(!wrap) return;
    wrap.innerHTML=s.spinner;
    s.call('getAllFeeOverview').then(function(data){
      var flat=[];
      (data||[]).forEach(function(cls){ (cls.students||[]).forEach(function(st){
        flat.push({ studentID:st.studentID, studentName:st.studentName, className:st.className, classNameFull:cls.classNameFull||st.className,
                    arrears:st.arrears||0, termFees:st.termFees||0, totalDue:st.totalDue, totalPaid:st.totalPaid, balance:st.balance, status:st.paymentStatus });
      }); });
      s._feeOvData=flat; s._renderFeeOverviewTable();
    }).catch(function(e){ if (document.getElementById('ovTableWrap')) document.getElementById('ovTableWrap').innerHTML=s.errHtml(e); });
  },
  _filteredFeeOverview: function(){
    var s=this, data=s._feeOvData||[];
    if (s._feeOvClass&&s._feeOvClass!=='All') data=data.filter(function(r){ return r.className===s._feeOvClass; });
    if (s._feeOvStatus&&s._feeOvStatus!=='All') data=data.filter(function(r){ return r.status===s._feeOvStatus; });
    if (s._feeOvSearch){ var q=s._feeOvSearch; data=data.filter(function(r){ return String(r.studentName||'').toLowerCase().includes(q)||String(r.studentID||'').toLowerCase().includes(q); }); }
    return data;
  },
  _renderFeeOverviewTable: function(){
    var s=this, wrap=document.getElementById('ovTableWrap'); if (!wrap) return;
    var data=s._filteredFeeOverview();
    var tDue=0,tPaid=0,tBal=0,tArr=0,nFull=0,nPartial=0,nUnpaid=0;
    data.forEach(function(r){ if (r.arrears>0) tArr+=r.arrears; tDue+=r.totalDue; tPaid+=r.totalPaid; tBal+=Math.max(0,r.balance); if(r.status==='Full') nFull++; else if(r.status==='Partial') nPartial++; else nUnpaid++; });
    document.getElementById('ovSummaryBar').innerHTML = '<div class="stat-strip">'+
      [['Students',data.length,'var(--blue)'],['Arrears',s.money(tArr),'var(--orange)'],['Total Due',s.money(tDue),'var(--gold)'],['Collected',s.money(tPaid),'var(--green)'],
       ['Outstanding',s.money(tBal),tBal>0?'var(--red)':'var(--green)'],['Fully Paid',nFull,'var(--green)'],['Partial',nPartial,'var(--gold)'],['Not Paid',nUnpaid,'var(--red)']]
      .map(function(d){ return '<div class="stat-strip-item"><div class="ssl">'+d[0]+'</div><div class="ssv" style="color:'+d[2]+';">'+d[1]+'</div></div>'; }).join('')+'</div>';
    var total=data.length, pages=Math.max(1,Math.ceil(total/s.PAGE_SIZE));
    s._feeOvPage=Math.min(s._feeOvPage,pages);
    var start=(s._feeOvPage-1)*s.PAGE_SIZE, slice=data.slice(start,start+s.PAGE_SIZE);
    wrap.innerHTML='';
    if (!total) { wrap.innerHTML='<p style="color:var(--text-muted);text-align:center;padding:30px;">No students match these filters.</p>'; return; }
    var rows=slice.map(function(r,i){
      var tr=document.createElement('tr'), sc=r.status==='Full'?'full':(r.status==='Partial'?'partial':'not-paid');
      [start+i+1,r.studentID,r.studentName,r.classNameFull||r.className,r.arrears>0.004?s.money(r.arrears):'—',s.money(r.totalDue),s.money(r.totalPaid),s.money(r.balance)].forEach(function(v,ci){
        var td=tr.insertCell(); td.textContent=v;
        if(ci===4 && r.arrears>0.004){ td.style.color='var(--orange)'; td.style.fontWeight='600'; }
        if(ci===7){ td.style.color=r.balance>0?'var(--red)':'var(--green)'; td.style.fontWeight='700'; }
      });
      var stTd=tr.insertCell(); var sp=document.createElement('span'); sp.className='payment-status '+sc; sp.textContent=r.status; stTd.appendChild(sp);
      tr.insertCell().appendChild(s._btn('💳 Pay','',function(){ s._showQuickPayModal(r); }));
      // Tap anywhere on the row (handy on phones, where the Pay column is off-screen)
      tr.style.cursor='pointer'; tr.title='Tap to record a payment';
      tr.onclick=function(e){ if (!e.target.closest('button')) s._showQuickPayModal(r); };
      return tr;
    });
    wrap.appendChild(s._buildTable(['#','Student ID','Student Name','Class','Arrears','Amount Due','Paid','Balance','Status','Action'],rows));
    if(pages>1) wrap.appendChild(s._buildPagination(s._feeOvPage,pages,total,start,function(p){ s._feeOvPage=p; s._renderFeeOverviewTable(); }));
  },
  // Exports what's on screen (respects filters).
  _exportFeeOverviewCSV: function(){
    var s=this, data=s._filteredFeeOverview(); if(!data.length){ s.modal.alert('No data to export.'); return; }
    var rows=[['Student ID','Student Name','Class','Arrears (GH₵)','Amount Due (GH₵)','Paid (GH₵)','Balance (GH₵)','Status']];
    data.forEach(function(r){ rows.push([r.studentID,r.studentName,r.classNameFull||r.className,Math.max(0,r.arrears||0).toFixed(2),r.totalDue.toFixed(2),r.totalPaid.toFixed(2),r.balance.toFixed(2),r.status]); });
    var csv=rows.map(function(row){ return row.map(function(cell){
      var v=String(cell===null||cell===undefined?'':cell);
      if (/^[=+\-@]/.test(v)) v="'"+v;   // stop spreadsheet formula injection
      return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;
    }).join(','); }).join('\n');
    var url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'}));
    var a=document.createElement('a'); a.href=url; a.download='fee_overview.csv'; a.click(); URL.revokeObjectURL(url);
  },
  _showQuickPayModal: function(r) {
    var s = this, E = function(v){ return s.escapeHtml(v); };
    var sc = r.status==='Full'?'full':(r.status==='Partial'?'partial':'not-paid');
    var idemKey = s.newIdemKey();   // one key per payment attempt; reused on retries
    var html =
      '<div style="text-align:left;">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:10px;">'+
          '<div><div style="font-size:16px;font-weight:700;color:var(--text-primary);">'+E(r.studentName)+'</div>'+
          '<div style="font-size:12px;color:var(--text-muted);">'+E(r.classNameFull||r.className)+' | ID: '+E(r.studentID)+'</div></div>'+
          '<span class="payment-status '+sc+'">'+E(r.status)+'</span>'+
        '</div>'+
        '<div class="grid-auto" style="margin-bottom:10px;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));">'+
          [r.arrears>0.004?['Arrears',r.arrears,'var(--orange)']:r.arrears<-0.004?['Credit b/f',-r.arrears,'var(--green)']:null,
           ['Term Fees',r.termFees,'var(--blue)'],['Paid',r.totalPaid,'var(--teal)'],['Balance',r.balance,r.balance>0?'var(--red)':'var(--green)']].filter(Boolean).map(function(x){
            return '<div style="background:var(--bg-secondary);border-radius:10px;padding:12px;text-align:center;"><div style="font-size:10px;text-transform:uppercase;color:var(--text-muted);">'+x[0]+'</div><div style="font-size:16px;font-weight:800;color:'+x[2]+';">'+s.money(x[1])+'</div></div>';
          }).join('')+
        '</div>'+
        '<div id="qpBreakdown" style="margin-bottom:14px;font-size:13px;"></div>'+
        '<div style="display:flex;gap:10px;flex-wrap:wrap;">'+
          '<input id="qpAmt" class="form-control" placeholder="Enter amount (GH₵)" type="number" step="0.01" min="0.01" style="flex:1;min-width:120px;">'+
          '<select id="qpMethod" class="form-control" style="flex:1;min-width:130px;"><option>Cash</option><option>Mobile Money</option><option>Bank</option></select>'+
        '</div>'+
        '<div style="display:flex;gap:10px;flex-wrap:wrap;">'+
          '<select id="qpFeeType" class="form-control" style="flex:1;min-width:140px;"><option value="General Payment">General Payment</option></select>'+
          '<input id="qpRef" class="form-control" placeholder="Reference / MoMo ID" style="flex:1;min-width:140px;">'+
        '</div>'+
        '<input id="qpDate" class="form-control" type="date" value="'+s.todayYMD()+'" max="'+s.todayYMD()+'">'+
        '<div id="qpError" style="color:var(--red);font-size:13px;min-height:18px;margin-top:6px;"></div>'+
      '</div>';
    s.modal.show('💳 Record Payment', html, [
      {text:'Cancel',cls:'btn-secondary'},
      {text:'💰 Record Payment',cb:function(){
        var btn=document.getElementById('mb1'), errEl=document.getElementById('qpError');
        var amt=Math.round((parseFloat(document.getElementById('qpAmt').value)||0)*100)/100;
        var method=document.getElementById('qpMethod').value, ref=document.getElementById('qpRef').value.trim();
        if (amt<=0) { errEl.textContent='Please enter a valid amount greater than 0.'; return false; }
        if (method==='Mobile Money' && !ref) { errEl.textContent='Enter the MoMo transaction ID.'; return false; }
        if (btn.disabled) return false;
        var go=function(){
          btn.disabled=true; btn.textContent='⏳ Saving…'; errEl.textContent='';
          s.call('recordFeePayment',{ studentID:r.studentID, amountPaid:amt, paymentMethod:method, feeType:document.getElementById('qpFeeType').value,
                                      momoTransactionID:ref, paymentDate:document.getElementById('qpDate').value, idempotencyKey:idemKey }).then(function(res){
            if (res && res.success) { s._showPaymentDone(res, amt); }
            else { errEl.textContent='❌ '+((res&&res.message)||'Payment failed.'); btn.disabled=false; btn.textContent='💰 Record Payment'; }
          }).catch(function(e){ errEl.textContent='❌ Error: '+e.message+' — you can safely retry; duplicates are blocked.'; btn.disabled=false; btn.textContent='💰 Record Payment'; });
        };
        if (r.balance > 0 && amt > r.balance + 0.004) {
          errEl.innerHTML='<span style="color:var(--gold)">This is more than the balance of '+s.money(r.balance)+'. The extra will be held as credit. Click again to confirm.</span>';
          if (btn.dataset.overOk==='1') go(); else btn.dataset.overOk='1';
          return false;
        }
        go(); return false;
      }}]);
    s.call('getStudentFeeSummary', { sid: r.studentID }).then(function(sum) {
      var sel = document.getElementById('qpFeeType'); if (!sel || !sum || !sum.breakdown) return;
      sel.innerHTML = '<option value="General Payment">General Payment</option>' +
        sum.breakdown.map(function(b){ return '<option value="'+E(b.component)+'">'+E(b.isArrears?'Arrears (previous terms)':b.component)+(b.balance>0?' (owes '+s.money(b.balance)+')':'')+'</option>'; }).join('');
      var bd = document.getElementById('qpBreakdown');
      if (bd && sum.breakdown.length) bd.innerHTML = '<table style="width:100%;border-collapse:collapse;">'+
        '<tr style="color:var(--text-muted);font-size:11px;text-transform:uppercase;"><td style="padding:4px 6px;">Item</td><td style="padding:4px 6px;text-align:right;">Due</td><td style="padding:4px 6px;text-align:right;">Paid</td><td style="padding:4px 6px;text-align:right;">Balance</td></tr>'+
        sum.breakdown.map(function(b){
          return '<tr style="border-top:1px solid var(--border);'+(b.isArrears?'background:rgba(255,145,0,.08);':'')+'"><td style="padding:5px 6px;font-weight:600;'+(b.isArrears?'color:var(--orange);':'')+'">'+E(b.component)+(b.isArrears?' <span style="font-weight:400;color:var(--text-muted);font-size:11px;">brought forward</span>':'')+'</td>'+
            '<td style="padding:5px 6px;text-align:right;">'+s.money(b.expected)+'</td><td style="padding:5px 6px;text-align:right;color:var(--teal);">'+s.money(b.paid)+'</td>'+
            '<td style="padding:5px 6px;text-align:right;font-weight:700;color:'+(b.balance>0?'var(--red)':'var(--green)')+';">'+s.money(b.balance)+'</td></tr>';
        }).join('')+'</table>'+(sum.breakdown[0]&&sum.breakdown[0].isArrears&&sum.breakdown[0].balance>0?'<div style="color:var(--text-muted);font-size:11px;margin-top:4px;">Payments clear arrears first, then this term\'s fees.</div>':'');
    }).catch(function(){});
  },
  _showPaymentDone: function(res, amt) {
    var s=this; s._feeOvData=[];
    if (res && res.queued) {
      s.modal.show('💾 Payment saved on this device', s.escapeHtml(s.money(amt)+' recorded while offline. '+res.message)+
        '<br><small style="color:var(--text-muted);">The receipt number is issued when it reaches the server; print the receipt from Payment History afterwards.</small>',
        [{text:'OK',cb:function(){ s._reloadFeeOverview(); }}]);
      return;
    }
    var msg = res.duplicate
      ? '⚠️ This payment was already recorded — a repeated submission (often caused by an unstable connection) was safely ignored. No extra charge was made.'
      : '✅ '+s.money(amt)+' recorded.';
    s.modal.show('✅ Payment Saved', s.escapeHtml(msg)+'<br><small style="color:var(--text-muted);">Receipt: '+s.escapeHtml(res.receiptNumber||'')+'</small>', [
      {text:'Close',cls:'btn-secondary',cb:function(){ s._reloadFeeOverview(); }},
      {text:'🖨️ Print Receipt',cb:function(){ s.printReceipt(res.transactionID); s._reloadFeeOverview(); }}
    ]);
  },
  // FIX: the edit form used the scholarship-adjusted amount, so saving
  // overrides for a partial-scholarship student applied the discount twice.
  // It now edits the pre-scholarship amount and skips one-off charges.
  _loadStudentFeeEditOnly: function(sid){
    var s=this, det=document.getElementById('feeDetails'); det.innerHTML=s.spinner;
    s.call('getStudentFeeSummary',{sid:sid}).then(function(sum){
      if(!sum.success){ det.innerHTML='<p style="color:var(--red);">'+s.escapeHtml(sum.message||'Error loading fees.')+'</p>'; return; }
      var breakdown=sum.breakdown||[]; det.innerHTML='';
      var sc=sum.paymentStatus==='Full'?'full':(sum.paymentStatus==='Partial'?'partial':'not-paid');
      var card=document.createElement('div'); card.className='fee-card';
      card.innerHTML='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:10px;flex-wrap:wrap;"><h3 style="margin:0;">'+s.escapeHtml(sum.student.fullName)+' ('+s.escapeHtml(sum.student.class)+')</h3><span class="payment-status '+sc+'">'+s.escapeHtml(sum.paymentStatus)+'</span></div>'+
        (sum.student.scholarship && sum.student.scholarship!=='None'?'<p style="color:var(--gold);font-size:13px;margin-bottom:12px;">🎓 Scholarship: '+s.escapeHtml(sum.student.scholarship==='Full'?'Full':'pays '+s.money(sum.student.scholarship)+' per term')+' — applied after the amounts below.</p>':'')+
        '<div class="fee-stats">'+
          '<div class="fee-stat"><div class="label">'+(sum.rolloverBalance<0?'Credit b/f':'Arrears')+'</div><div class="value" style="color:'+(sum.rolloverBalance>0?'var(--orange)':'var(--green)')+'">'+s.money(Math.abs(sum.rolloverBalance))+'</div></div>'+
          '<div class="fee-stat"><div class="label">Term Fees</div><div class="value" style="color:var(--green)">'+s.money(sum.totalExpected)+'</div></div>'+
          '<div class="fee-stat"><div class="label">Paid</div><div class="value" style="color:var(--teal)">'+s.money(sum.totalPaid)+'</div></div>'+
          '<div class="fee-stat"><div class="label">Balance</div><div class="value" style="color:'+(sum.totalBalance>0?'var(--red)':'var(--green)')+'">'+s.money(sum.totalBalance)+'</div></div>'+
        '</div>';
      det.appendChild(card);
      var bSection=document.createElement('div'); bSection.style.marginBottom='24px';
      bSection.innerHTML='<div style="display:flex;align-items:center;justify-content:space-between;margin:20px 0 10px;"><h4 style="margin:0;">Fee Breakdown</h4><button class="btn btn-gold btn-sm" id="editFeesBtn" style="padding:6px 16px;">✏️ Edit Fees</button></div><div id="feeBreakdownWrap"></div>';
      det.appendChild(bSection);
      if (!breakdown.length) { document.getElementById('feeBreakdownWrap').innerHTML='<p style="color:var(--text-muted);">No fee items set for this class this term. Add them under Settings → Fee Items.</p>'; document.getElementById('editFeesBtn').style.display='none'; return; }
      var renderBreakdown=function(mode){
        var wrap=document.getElementById('feeBreakdownWrap');
        var headers=['Fee Component','Amount Due','Paid','Balance']; if(mode==='edit') headers.push('Amount before scholarship (GH₵)');
        var rows=breakdown.map(function(row){
          var tr=document.createElement('tr');
          var tdN=tr.insertCell(); tdN.textContent=row.component+(row.isCharge?' (one-off)':'')+(row.isArrears?' (brought forward)':''); tdN.style.fontWeight='600'; if (row.isArrears) tdN.style.color='var(--orange)';
          tr.insertCell().textContent=s.money(row.expected);
          var tdP=tr.insertCell(); tdP.textContent=s.money(row.paid); tdP.style.color='var(--teal)';
          var tdB=tr.insertCell(); tdB.textContent=s.money(row.balance); tdB.style.color=row.balance>0?'var(--red)':'var(--green)'; tdB.style.fontWeight='700';
          if(mode==='edit'){
            var td=tr.insertCell();
            if (row.isCharge || row.isArrears) { td.textContent='—'; }
            else {
              var inp=document.createElement('input'); inp.type='number'; inp.step='0.01'; inp.min='0'; inp.className='form-control';
              inp.dataset.component=row.component; inp.value=(parseFloat(row.preScholarship)||0).toFixed(2); inp.style.cssText='padding:6px 10px;width:140px;margin:0;';
              td.appendChild(inp);
              if (row.standard!==row.preScholarship) { var note=document.createElement('div'); note.style.cssText='font-size:11px;color:var(--text-muted);'; note.textContent='Standard: '+s.money(row.standard); td.appendChild(note); }
            }
          }
          return tr;
        });
        wrap.innerHTML=''; wrap.appendChild(s._buildTable(headers,rows));
        if(mode==='edit'){
          var btnRow=document.createElement('div'); btnRow.style.cssText='display:flex;gap:10px;margin-top:10px;';
          var saveBtn=s._btn('💾 Save Overrides','',null,'padding:10px 20px;font-size:14px;');
          var cancelBtn=s._btn('Cancel','btn-secondary',function(){ document.getElementById('editFeesBtn').style.display=''; renderBreakdown('view'); },'padding:10px 20px;font-size:14px;');
          saveBtn.onclick=function(){
            var overrides=[], bad=false;
            wrap.querySelectorAll('input[data-component]').forEach(function(i){ var v=parseFloat(i.value); if(isNaN(v)||v<0) bad=true; overrides.push({component:i.dataset.component,amount:v}); });
            if (bad) { s.modal.alert('Amounts must be zero or more.'); return; }
            s.safeSubmit(saveBtn, function(){
              return s.call('saveStudentFeeOverrides',{sid:sid,overrides:overrides}).then(function(res){
                if(res.success){ s._feeOvData=[]; return s.modal.alert('✅ Fee overrides saved.').then(function(){ s._loadStudentFeeEditOnly(sid); }); }
                s.modal.alert('❌ '+res.message);
              });
            });
          };
          btnRow.appendChild(saveBtn); btnRow.appendChild(cancelBtn); wrap.appendChild(btnRow);
        }
      };
      renderBreakdown('view');
      document.getElementById('editFeesBtn').onclick=function(){ this.style.display='none'; renderBreakdown('edit'); };
    }).catch(function(e){ det.innerHTML=s.errHtml(e); });
  },
  // FIX: history only showed the current term; it now uses the all-terms
  // getStudentPaymentHistory endpoint (which existed but was unused).
  _loadStudentPaymentHistory: function(sid){
    var s=this, det=document.getElementById('histDetails'); det.innerHTML=s.spinner;
    Promise.all([s.call('getStudentFeeSummary',{sid:sid}).catch(function(){ return null; }), s.call('getStudentPaymentHistory',{sid:sid})]).then(function(res){
      var sum=res[0], hist=res[1];
      if(!hist||!hist.success){ det.innerHTML='<p style="color:var(--red);">'+s.escapeHtml((hist&&hist.message)||'Error.')+'</p>'; return; }
      det.innerHTML='';
      var card=document.createElement('div'); card.className='fee-card';
      var head='<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;"><div><h3 style="margin:0 0 4px;">'+s.escapeHtml(hist.studentName)+'</h3><span style="font-size:13px;color:var(--text-muted);">'+s.escapeHtml(hist.class)+' | '+s.escapeHtml(hist.studentID)+'</span></div>';
      if (sum && sum.success) {
        var sc=sum.paymentStatus==='Full'?'full':(sum.paymentStatus==='Partial'?'partial':'not-paid');
        head+='<span class="payment-status '+sc+'">This term: '+s.escapeHtml(sum.paymentStatus)+'</span></div>'+
          '<div class="fee-stats" style="margin-top:16px;">'+
            '<div class="fee-stat"><div class="label">Due This Term</div><div class="value" style="color:var(--gold)">'+s.money(sum.totalDue)+'</div></div>'+
            '<div class="fee-stat"><div class="label">Paid This Term</div><div class="value" style="color:var(--green)">'+s.money(sum.totalPaid)+'</div></div>'+
            '<div class="fee-stat"><div class="label">Balance</div><div class="value" style="color:'+(sum.totalBalance>0?'var(--red)':'var(--green)')+'">'+s.money(sum.totalBalance)+'</div></div>'+
            '<div class="fee-stat"><div class="label">All-time Payments</div><div class="value" style="color:var(--blue)">'+hist.payments.length+'</div></div>'+
          '</div>';
      } else head+='</div>';
      card.innerHTML=head; det.appendChild(card);
      var payments=hist.payments||[];
      if(!payments.length){ var em=document.createElement('div'); em.innerHTML='<div style="text-align:center;padding:40px;color:var(--text-muted);background:var(--bg-secondary);border-radius:12px;border:1px dashed var(--border);"><div style="font-size:32px;margin-bottom:8px;">📭</div><p>No payment records found.</p></div>'; det.appendChild(em); return; }
      var totalPd=payments.reduce(function(a,p){ return a+(parseFloat(p.amount)||0); },0);
      var strip=document.createElement('div'); strip.style.cssText='display:flex;align-items:center;justify-content:space-between;margin:20px 0 12px;gap:10px;flex-wrap:wrap;';
      strip.innerHTML='<h4 style="margin:0;">Payment History ('+payments.length+' transaction'+(payments.length!==1?'s':'')+')</h4><span style="font-weight:700;color:var(--green);">Total: '+s.money(totalPd)+'</span>';
      det.appendChild(strip);
      var rows=payments.map(function(p){
        var tr=document.createElement('tr');
        [s.niceDate(p.date),(s.TERM_NAMES[p.term]||('T'+p.term))+' '+(p.academicYear||''),p.feeType||'General',s.money(p.amount),p.method||'',p.receipt||''].forEach(function(v,ci){
          var td=tr.insertCell(); td.textContent=v;
          if(ci===3){ td.style.color=p.reversed?'var(--text-muted)':'var(--green)'; td.style.fontWeight='700'; if (p.reversed) td.style.textDecoration='line-through'; }
          if(ci===5 && p.reversed){ var b=document.createElement('span'); b.className='payment-status not-paid'; b.style.marginLeft='6px'; b.textContent='Reversed'; td.appendChild(b); }
        });
        var td=tr.insertCell(); td.style.whiteSpace='nowrap';
        if(p.transactionID) td.appendChild(s._btn('🖨️ Receipt','',function(){ s.printReceipt(p.transactionID); }));
        if(p.transactionID && !p.reversed && s.can('fees.reverse')) td.appendChild(s._btn('↩ Reverse','btn-danger',function(){
          s.modal.show('Reverse payment '+s.escapeHtml(p.receipt||''),
            'Reverse <b>'+s.escapeHtml(s.money(p.amount))+'</b> paid on '+s.escapeHtml(s.niceDate(p.date))+'? The receipt stays on record marked <b>Reversed</b> and the amount is added back to what the student owes.'+
            '<textarea id="revReason" class="form-control" rows="2" placeholder="Reason (required), e.g. entered for the wrong student" style="margin-top:10px;"></textarea><div id="revErr" style="color:var(--red);font-size:13px;"></div>',
            [{text:'Cancel',cls:'btn-secondary'},{text:'↩ Reverse',cls:'btn-danger',cb:function(){
              var reason=document.getElementById('revReason').value.trim(), err=document.getElementById('revErr'), btn=document.getElementById('mb1');
              if (!reason) { err.textContent='Please give a reason.'; return false; }
              if (btn.disabled) return false;
              btn.disabled=true; err.textContent='Reversing…';
              s.call('reverseFeePayment',{tid:p.transactionID,reason:reason}).then(function(r){
                if (r.success) { s.modal.close(); s._feeOvData=[]; s.modal.alert('✅ '+r.message).then(function(){ s._loadStudentPaymentHistory(sid); }); }
                else { err.textContent='❌ '+r.message; btn.disabled=false; }
              }).catch(function(e){ err.textContent='❌ '+e.message; btn.disabled=false; });
              return false;
            }}]);
        },'margin-left:4px;'));
        return tr;
      });
      det.appendChild(s._buildTable(['Date','Term','Fee Type','Amount','Method','Receipt No','Action'],rows));
    }).catch(function(e){ det.innerHTML=s.errHtml(e); });
  },

  /* ═══ FINANCES ═══ */
  loadFinances: function(el){
    var s=this;
    el.innerHTML='<div class="tab-bar">'+
      '<button class="btn tab-btn active" data-fin="ov">Fee Overview</button>'+
      '<button class="btn tab-btn" data-fin="rep">📋 Financial Report</button>'+
      '<button class="btn tab-btn" data-fin="ie">📑 Income &amp; Expenditure</button>'+
      '<button class="btn tab-btn" data-fin="sum">📊 Summary</button>'+
      '</div><div id="finContent">'+s.spinner+'</div>';
    var fns={ov:function(){ s.loadFeeOverview(); },rep:function(){ s.showFinancialReportInline(); },ie:function(){ s.showIncomeExpenditureStatement(); },sum:function(){ s.showFinancialSummary(); }};
    el.querySelectorAll('[data-fin]').forEach(function(b){ b.onclick=function(){ el.querySelectorAll('[data-fin]').forEach(function(x){ x.classList.toggle('active',x===b); }); fns[b.dataset.fin](); }; });
    s.loadFeeOverview();
  },
  loadFeeOverview: function(){
    var s=this, c=document.getElementById('finContent'); c.innerHTML=s.spinner;
    s.call('getAllFeeOverview').then(function(data){
      if(!data||!data.length){ c.innerHTML='<p style="color:var(--text-muted);text-align:center;padding:40px;">No fee data.</p>'; return; }
      var frag=document.createDocumentFragment(), tDue=0,tPaid=0,tBal=0,tSt=0;
      data.forEach(function(cls){ cls.students.forEach(function(st){ tDue+=st.totalDue; tPaid+=st.totalPaid; tBal+=Math.max(0,st.balance); tSt++; }); });
      var sumDiv=document.createElement('div'); sumDiv.className='summary-grid';
      [['Total Students',tSt,'var(--blue)'],['Total Due',s.money(tDue),'var(--gold)'],['Collected',s.money(tPaid),'var(--green)'],['Outstanding',s.money(tBal),'var(--red)']].forEach(function(d){
        var card=document.createElement('div'); card.style.cssText='background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center;';
        card.innerHTML='<div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);">'+d[0]+'</div><div style="font-size:22px;font-weight:800;color:'+d[2]+';">'+d[1]+'</div>';
        sumDiv.appendChild(card);
      });
      frag.appendChild(sumDiv);
      data.forEach(function(cls){
        var paid=cls.students.filter(function(st){return st.paymentStatus==='Full';}).length;
        var partial=cls.students.filter(function(st){return st.paymentStatus==='Partial';}).length;
        var unpaid=cls.students.length-paid-partial;
        var header=document.createElement('div'); header.className='cls-header';
        header.innerHTML='<span>'+s.escapeHtml(cls.classNameFull)+' <small style="color:var(--text-muted);">('+cls.students.length+')</small></span>'+
          '<span><span class="cls-badge" style="background:var(--green-bg);color:var(--green);margin-right:4px;">'+paid+' Full</span><span class="cls-badge" style="background:var(--gold-bg);color:var(--gold);margin-right:4px;">'+partial+' Partial</span><span class="cls-badge" style="background:var(--red-bg);color:var(--red);">'+unpaid+' Unpaid</span></span>';
        var body=document.createElement('div'); body.className='cls-body'; var rendered=false;
        header.onclick=function(){ var open=body.classList.toggle('open'); if(open&&!rendered){ rendered=true; s._renderFeeClassTable(body,cls.students,1); } };
        frag.appendChild(header); frag.appendChild(body);
      });
      c.innerHTML=''; c.appendChild(frag);
    }).catch(function(e){ c.innerHTML=s.errHtml(e); });
  },
  _renderFeeClassTable: function(container,students,page){
    var s=this, total=students.length, pages=Math.max(1,Math.ceil(total/s.PAGE_SIZE));
    page=Math.min(page||1,pages); var start=(page-1)*s.PAGE_SIZE, slice=students.slice(start,start+s.PAGE_SIZE);
    var rows=slice.map(function(st){
      var tr=document.createElement('tr'), sc=st.paymentStatus==='Full'?'full':(st.paymentStatus==='Partial'?'partial':'not-paid');
      [st.studentName,s.money(st.totalDue),s.money(st.totalPaid),s.money(st.balance)].forEach(function(v){ tr.insertCell().textContent=v; });
      var sp=document.createElement('span'); sp.className='payment-status '+sc; sp.textContent=st.paymentStatus; tr.insertCell().appendChild(sp);
      return tr;
    });
    container.innerHTML='';
    container.appendChild(s._buildTable(['Student','Due','Paid','Balance','Status'],rows));
    if(pages>1) container.appendChild(s._buildPagination(page,pages,total,start,function(p){ s._renderFeeClassTable(container,students,p); }));
  },
  showFinancialReportInline: function(){
    var s=this, c=document.getElementById('finContent'), yr=new Date().getFullYear();
    c.innerHTML='<div style="max-width:800px;margin:0 auto;"><div style="display:flex;gap:10px;margin-bottom:20px;align-items:center;flex-wrap:wrap;">'+
      '<label>From:</label><input id="repStart" class="form-control" type="date" value="'+yr+'-01-01" style="width:160px;">'+
      '<label>To:</label><input id="repEnd" class="form-control" type="date" value="'+s.todayYMD()+'" style="width:160px;">'+
      '<button class="btn" id="genRepBtn" style="margin-top:5px;">🔍 Generate</button></div>'+
      '<p style="color:var(--text-muted);font-size:12px;margin-bottom:12px;">Fees received and school expenses recorded between the two dates, across all terms. Canteen money is reported on the Canteen page.</p><div id="repResults"></div></div>';
    document.getElementById('genRepBtn').onclick=function(){
      var b=this, out=document.getElementById('repResults'), st=document.getElementById('repStart').value, en=document.getElementById('repEnd').value;
      if (st && en && st > en) { s.modal.alert('The start date must be before the end date.'); return; }
      b.disabled=true; out.innerHTML=s.spinner;
      s.call('getFinancialReport',{startDate:st,endDate:en}).then(function(r){
        var catRows=Object.keys(r.expensesByCategory||{}).map(function(k){ return '<tr><td>'+s.escapeHtml(k)+'</td><td>'+s.money(r.expensesByCategory[k])+'</td></tr>'; }).join('');
        out.innerHTML='<div class="fee-stats grid-auto" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));">'+
          '<div class="fee-stat"><div class="label">Fees</div><div class="value" style="color:var(--green)">'+s.money(r.totalFees)+'</div></div>'+
          '<div class="fee-stat"><div class="label">Expenses</div><div class="value" style="color:var(--red)">'+s.money(r.totalExpenses)+'</div></div>'+
          '<div class="fee-stat"><div class="label">Net Balance</div><div class="value" style="color:'+(r.netBalance>=0?'var(--green)':'var(--red)')+'">'+s.money(r.netBalance)+'</div></div></div>'+
          (catRows?'<h4 style="margin-top:20px;">Expenses by Category</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>Category</th><th>Amount</th></tr></thead><tbody>'+catRows+'</tbody></table></div>':'');
      }).catch(function(e){ out.innerHTML=s.errHtml(e); }).then(function(){ b.disabled=false; });
    };
  },
  showIncomeExpenditureStatement: function(){
    var s=this, c=document.getElementById('finContent');
    c.innerHTML='<div style="max-width:900px;margin:0 auto;">'+
        '<div class="tab-bar">'+
          '<button class="btn tab-btn active" data-iem="term">📘 This Term</button>'+
          '<button class="btn tab-btn" data-iem="annual">📗 Full Academic Year</button>'+
          '<button class="btn tab-btn" data-iem="custom">🗓️ Custom Range</button>'+
        '</div><div id="ieControls" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:18px;"></div><div id="ieResults"></div></div>';
    s.getConfig().then(function(cfg){
      var curTerm=(cfg&&cfg.currentTerm)||1, curYear=(cfg&&cfg.currentAcademicYear)||'';
      c.querySelectorAll('[data-iem]').forEach(function(b){ b.onclick=function(){ c.querySelectorAll('[data-iem]').forEach(function(x){ x.classList.toggle('active',x===b); }); s._renderIEControls(b.dataset.iem,curTerm,curYear); }; });
      s._renderIEControls('term',curTerm,curYear);
    }).catch(function(e){ c.innerHTML=s.errHtml(e); });
  },
  _renderIEControls: function(mode, curTerm, curYear){
    var s=this, wrap=document.getElementById('ieControls');
    document.getElementById('ieResults').innerHTML='<div style="text-align:center;padding:30px;color:var(--text-muted);">Click <b>Generate</b> to view the statement.</div>';
    var yearInput='<input id="ieYearInput" class="form-control" style="width:140px;" value="'+s.escapeHtml(curYear)+'" placeholder="2025/2026">';
    var genBtn='<button class="btn" id="genIEBtn" style="margin-top:5px;">🔍 Generate</button>';
    if (mode==='term') {
      wrap.innerHTML='<select id="ieTermSelect" class="form-control" style="width:auto;">'+[1,2,3].map(function(t){ return '<option value="'+t+'"'+(t==curTerm?' selected':'')+'>'+s.TERM_NAMES[t]+'</option>'; }).join('')+'</select>'+yearInput+genBtn;
    } else if (mode==='annual') {
      wrap.innerHTML=yearInput+genBtn;
    } else {
      wrap.innerHTML='<label>From:</label><input id="ieStart" class="form-control" type="date" value="'+new Date().getFullYear()+'-01-01" style="width:160px;">'+
        '<label>To:</label><input id="ieEnd" class="form-control" type="date" value="'+s.todayYMD()+'" style="width:160px;">'+genBtn;
    }
    document.getElementById('genIEBtn').onclick=function(){
      var p={mode:mode};
      if (mode!=='custom') {
        p.academicYear=document.getElementById('ieYearInput').value.trim();
        if (!/^\d{4}\/\d{4}$/.test(p.academicYear)) { s.modal.alert('Academic year must look like 2025/2026.'); return; }
        if (mode==='term') p.term=document.getElementById('ieTermSelect').value;
      } else { p.startDate=document.getElementById('ieStart').value; p.endDate=document.getElementById('ieEnd').value; }
      s._generateIEStatement(p, this);
    };
  },
  _generateIEStatement: function(payload, btn){
    var s=this, out=document.getElementById('ieResults');
    btn.disabled=true; btn.textContent='⏳ Generating…'; out.innerHTML=s.spinner;
    s.call('getIncomeExpenditureStatement', payload).then(function(r){
      if (!r || !r.success) { out.innerHTML='<p style="color:var(--red);text-align:center;padding:20px;">Error generating statement.</p>'; return; }
      var rowsHtml=function(list,color,empty){ return list.length ? list.map(function(row){ return '<tr><td>'+s.escapeHtml(row.label)+'</td><td style="text-align:right;color:'+color+';font-weight:600;">'+s.money(row.amount)+'</td></tr>'; }).join('')
        : '<tr><td colspan="2" style="color:var(--text-muted);text-align:center;padding:16px;">'+empty+'</td></tr>'; };
      var netLabel=r.netSurplus>=0?'Net Surplus':'Net Deficit', netColor=r.netSurplus>=0?'var(--green)':'var(--red)';
      out.innerHTML=
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">'+
          '<span style="color:var(--text-muted);font-size:13px;">'+s.escapeHtml(r.periodLabel||'')+'</span>'+
          '<button class="btn btn-secondary" id="printIEBtn" style="margin-top:0;">🖨️ Print Statement</button></div>'+
        '<div class="two-col" style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">'+
          '<div class="table-wrap"><h4 style="color:var(--green);margin-bottom:10px;">💵 Income</h4><table class="data-table"><thead><tr><th>Source</th><th style="text-align:right;">Amount</th></tr></thead><tbody>'+rowsHtml(r.incomeRows,'var(--green)','No income recorded for this period.')+'</tbody>'+
            '<tfoot><tr><td style="font-weight:700;color:var(--text-primary);">Total Income</td><td style="text-align:right;font-weight:700;color:var(--green);">'+s.money(r.totalIncome)+'</td></tr></tfoot></table></div>'+
          '<div class="table-wrap"><h4 style="color:var(--red);margin-bottom:10px;">💸 Expenditure</h4><table class="data-table"><thead><tr><th>Category</th><th style="text-align:right;">Amount</th></tr></thead><tbody>'+rowsHtml(r.expenditureRows,'var(--red)','No expenditure recorded for this period.')+'</tbody>'+
            '<tfoot><tr><td style="font-weight:700;color:var(--text-primary);">Total Expenditure</td><td style="text-align:right;font-weight:700;color:var(--red);">'+s.money(r.totalExpenditure)+'</td></tr></tfoot></table></div>'+
        '</div>'+
        '<div style="margin-top:20px;padding:18px 22px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;display:flex;justify-content:space-between;align-items:center;">'+
          '<span style="font-weight:700;font-size:16px;">'+netLabel+'</span><span style="font-weight:800;font-size:22px;color:'+netColor+';">'+s.money(Math.abs(r.netSurplus))+'</span></div>'+
        (payload.mode!=='custom'?'<p style="color:var(--text-muted);font-size:12px;margin-top:10px;">Note: expenses recorded before term-stamping was added only appear in Custom Range reports.</p>':'');
      document.getElementById('printIEBtn').onclick=function(){ document.getElementById('printContent').innerHTML=s._buildIncomeExpenditureHTML(r); App.printContent(); };
    }).catch(function(e){ out.innerHTML=s.errHtml(e); })
      .then(function(){ btn.disabled=false; btn.textContent='🔍 Generate'; });
  },
  _buildIncomeExpenditureHTML: function(data) {
    var s=this;
    var rows=function(list,empty){ return list.length ? list.map(function(r){ return '<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">'+s.escapeHtml(r.label)+'</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">'+s.money(r.amount)+'</td></tr>'; }).join('')
      : '<tr><td colspan="2" style="padding:10px;color:#888;text-align:center;">'+empty+'</td></tr>'; };
    var netLabel=data.netSurplus>=0?'Net Surplus':'Net Deficit', netColor=data.netSurplus>=0?'#006B3F':'#CE1126';
    return '<div style="max-width:700px;margin:0 auto;background:#fff;color:#1a1a1a;padding:30px;font-family:Georgia,serif;">'+
      '<div style="text-align:center;margin-bottom:22px;border-bottom:2px solid #006B3F;padding-bottom:14px;">'+
        '<h2 style="color:#006B3F;margin:0;text-transform:uppercase;">'+s.escapeHtml(data.schoolName||'')+'</h2>'+
        '<p style="margin:6px 0 0;font-weight:700;font-size:15px;letter-spacing:.5px;">INCOME AND EXPENDITURE STATEMENT</p>'+
        '<p style="margin:2px 0 0;color:#555;font-size:12px;">'+s.escapeHtml(data.periodLabel||'')+'</p></div>'+
      '<h4 style="color:#006B3F;border-bottom:1px solid #ddd;padding-bottom:6px;margin:0 0 6px;">Income</h4>'+
      '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:6px;"><tbody>'+rows(data.incomeRows,'No income recorded')+
        '<tr><td style="padding:8px 10px;font-weight:700;border-top:2px solid #006B3F;">Total Income</td><td style="padding:8px 10px;font-weight:700;border-top:2px solid #006B3F;text-align:right;">'+s.money(data.totalIncome)+'</td></tr></tbody></table>'+
      '<h4 style="color:#CE1126;border-bottom:1px solid #ddd;padding-bottom:6px;margin:22px 0 6px;">Expenditure</h4>'+
      '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:6px;"><tbody>'+rows(data.expenditureRows,'No expenditure recorded')+
        '<tr><td style="padding:8px 10px;font-weight:700;border-top:2px solid #CE1126;">Total Expenditure</td><td style="padding:8px 10px;font-weight:700;border-top:2px solid #CE1126;text-align:right;">'+s.money(data.totalExpenditure)+'</td></tr></tbody></table>'+
      '<div style="margin-top:22px;padding:16px 20px;background:#f5f5f5;border-radius:8px;display:flex;justify-content:space-between;align-items:center;">'+
        '<span style="font-weight:700;font-size:15px;">'+netLabel+'</span><span style="font-weight:700;font-size:20px;color:'+netColor+';">'+s.money(Math.abs(data.netSurplus))+'</span></div>'+
      '<p style="margin-top:26px;font-size:10px;color:#999;text-align:center;">Prepared by iSmartSchool — '+new Date().toLocaleDateString('en-GB')+'</p></div>';
  },
  showFinancialSummary: function(){
    var s=this, c=document.getElementById('finContent'); c.innerHTML=s.spinner;
    s.call('getFinancialSummary').then(function(d){
      if(!d.success){ c.innerHTML='<p style="color:var(--red);text-align:center;">Error.</p>'; return; }
      c.innerHTML='<div style="max-width:800px;margin:0 auto;">'+
        '<div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:16px;padding:24px;text-align:center;margin-bottom:24px;">'+
          '<h3 style="color:var(--gold);margin:0 0 5px;">📊 Financial Summary</h3>'+
          '<p style="color:var(--text-muted);font-size:13px;margin:0;">'+s.escapeHtml(s.TERM_NAMES[d.term]||('Term '+d.term))+' – '+s.escapeHtml(d.academicYear)+' | Active Students: <b>'+d.activeStudentCount+'</b></p></div>'+
        '<div class="two-col" style="display:grid;grid-template-columns:repeat(2,1fr);gap:16px;">'+
        [['Term Fees (New)',d.totalAmountDue,'var(--blue)'],['Arrears Brought Forward',d.totalRolloverOwed,'var(--purple)'],
         ['Overpayment Credit',d.totalRolloverCredit,'var(--teal)'],['Total Expected',d.totalExpected,'var(--gold)'],
         ['Received (Term)',d.totalReceived,'var(--green)'],['Outstanding',d.totalOutstanding,d.totalOutstanding>0?'var(--red)':'var(--green)']]
        .map(function(cd){ return '<div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:14px;padding:20px;border-left:4px solid '+cd[2]+';"><div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">'+cd[0]+'</div><div style="font-size:26px;font-weight:800;color:'+cd[2]+';">'+s.money(cd[1])+'</div></div>'; }).join('')+
        '</div></div>';
    }).catch(function(e){ c.innerHTML=s.errHtml(e); });
  },

  /* ═══ EXPENSES ═══ */
  loadExpenses: function(el){
    var s=this;
    var loadCats=s._cache.expCats?Promise.resolve(s._cache.expCats):s.call('getExpenseCategories',{},'expCats').then(function(c){ s._cache.expCats=c||[]; return s._cache.expCats; });
    Promise.all([s.getExpensesCached(),loadCats]).then(function(res){
      var exp=res[0]; s._expData=exp; s._expPage=1;
      var total=exp.reduce(function(a,e){ return a+(parseFloat(e['Amount(GH₵)'])||0); },0);
      el.innerHTML='<div class="summary-grid" style="margin-bottom:24px;">'+
        '<div class="stat-card" style="border-left:3px solid var(--green)"><div class="stat-value" style="color:var(--green)">'+s.money(total)+'</div><div class="stat-label">Total (all time)</div></div>'+
        '<div class="stat-card" style="border-left:3px solid var(--gold)"><div class="stat-value" style="color:var(--gold)">'+exp.length+'</div><div class="stat-label">Transactions</div></div>'+
        '<div class="stat-card" style="border-left:3px solid var(--blue)"><div class="stat-value" style="color:var(--blue)">'+new Set(exp.map(function(e){ return e.Category||'General'; })).size+'</div><div class="stat-label">Categories</div></div></div>'+
        '<div style="display:flex;gap:10px;margin-bottom:15px;flex-wrap:wrap;"><button class="btn" id="addExpBtn">+ Record Expense</button><button class="btn btn-secondary" id="manageCatsBtn">📋 Categories</button></div>'+
        '<div id="expenseForm" class="hidden" style="background:var(--bg-secondary);border-radius:16px;padding:20px;margin-bottom:16px;"></div><div id="expTableWrap"></div>';
      document.getElementById('addExpBtn').onclick=function(){ s.showExpenseForm(); };
      document.getElementById('manageCatsBtn').onclick=function(){ s.showCategoryManager(); };
      s._renderExpenseTable();
    }).catch(function(e){ el.innerHTML=s.errHtml(e); });
  },
  _reloadExpenses: function(){ var s=this; s.invalidateExpenses(); return s.loadExpenses(document.getElementById('pageBody')); },
  _renderExpenseTable: function(){
    var s=this, wrap=document.getElementById('expTableWrap'); if(!wrap) return;
    var data=s._expData, total=data.length, pages=Math.max(1,Math.ceil(total/s.PAGE_SIZE));
    s._expPage=Math.min(s._expPage,pages); var start=(s._expPage-1)*s.PAGE_SIZE, slice=data.slice(start,start+s.PAGE_SIZE);
    wrap.innerHTML='';
    if (!total) { wrap.innerHTML='<p style="color:var(--text-muted);text-align:center;padding:30px;">No expenses recorded yet.</p>'; return; }
    var rows=slice.map(function(e){
      var tr=document.createElement('tr');
      [s.niceDate(e.Date),e.Description,e.Category,s.money(e['Amount(GH₵)']),e.VoucherNumber||''].forEach(function(v){ tr.insertCell().textContent=v; });
      var td=tr.insertCell();
      if (/^PAYROLL\|/.test(e.IdempotencyKey||'')) { td.innerHTML='<span title="Posted by Payroll. Reverse the month on the Payroll page to change it." style="color:var(--text-muted);font-size:12px;white-space:nowrap;">🔒 Payroll</span>'; return tr; }
      td.appendChild(s._btn('Edit','',function(){ s.showExpenseForm(e.ExpenseID); }));
      if (s.can('expenses.delete')) td.appendChild(s._btn('Del','btn-danger',function(){ s.deleteExpense(e); },'margin-left:4px;'));
      return tr;
    });
    wrap.appendChild(s._buildTable(['Date','Description','Category','Amount','Voucher','Actions'],rows));
    if(pages>1) wrap.appendChild(s._buildPagination(s._expPage,pages,total,start,function(p){ s._expPage=p; s._renderExpenseTable(); }));
  },
  showExpenseForm: function(eid){
    var s=this, f=document.getElementById('expenseForm'); f.classList.remove('hidden');
    var cats=(s._cache.expCats||[]).slice(); if (cats.indexOf('Other')<0) cats.push('Other');
    var pre=eid?(s._expData.find(function(e){ return e.ExpenseID===eid; })||{}):{};
    if (pre.Category && cats.indexOf(pre.Category)<0) cats.unshift(pre.Category);
    var idemKey=!eid?s.newIdemKey():null;
    f.innerHTML='<h3 style="margin-bottom:10px;">'+(eid?'Edit Expense':'Record Expense')+'</h3>'+
      '<div class="two-col" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">'+
        '<div><label>Date</label><input id="expDate" type="date" class="form-control" max="'+s.todayYMD()+'" value="'+s.escapeHtml(pre.Date||s.todayYMD())+'"></div>'+
        '<div><label>Amount (GH₵)</label><input id="expAmt" type="number" step="0.01" min="0.01" class="form-control" value="'+s.escapeHtml(pre['Amount(GH₵)']||'')+'"></div>'+
        '<div><label>Description</label><input id="expDesc" class="form-control" value="'+s.escapeHtml(pre.Description||'')+'"></div>'+
        '<div><label>Category</label><select id="expCat" class="form-control">'+cats.map(function(c){ return '<option value="'+s.escapeHtml(c)+'"'+(pre.Category===c?' selected':'')+'>'+s.escapeHtml(c)+'</option>'; }).join('')+'</select></div>'+
        '<div><label>Paid By</label><input id="expPaidBy" class="form-control" value="'+s.escapeHtml(pre.PaidBy||'')+'"></div>'+
        '<div><label>Notes</label><input id="expNotes" class="form-control" value="'+s.escapeHtml(pre.Notes||'')+'"></div>'+
      '</div><div id="expErr" style="color:var(--red);font-size:13px;min-height:18px;margin-top:6px;"></div>'+
      '<div><button class="btn" id="saveExpBtn">💾 Save</button> <button class="btn btn-secondary" id="cancelExpBtn">Cancel</button></div>';
    document.getElementById('cancelExpBtn').onclick=function(){ s.hideExpenseForm(); };
    document.getElementById('saveExpBtn').onclick=function(){
      var err=document.getElementById('expErr');
      var payload={date:document.getElementById('expDate').value,description:document.getElementById('expDesc').value.trim(),category:document.getElementById('expCat').value,
                   amount:parseFloat(document.getElementById('expAmt').value)||0,paidBy:document.getElementById('expPaidBy').value.trim(),notes:document.getElementById('expNotes').value.trim()};
      if (!payload.description) { err.textContent='Please enter a description.'; return; }
      if (payload.amount<=0) { err.textContent='Please enter an amount greater than 0.'; return; }
      if (eid) payload.expenseID=eid; else payload.idempotencyKey=idemKey;
      s.safeSubmit(this, function(){
        return s.call(eid?'updateExpense':'recordExpense',payload).then(function(res){
          if (!res.success) { err.textContent='❌ '+res.message; return; }
          return s.modal.alert(res.duplicate?'⚠️ This expense was already recorded — the repeated submission was safely ignored.':'✅ '+res.message+(res.voucherNumber?' (Voucher '+res.voucherNumber+')':''))
            .then(function(){ s._reloadExpenses(); });
        });
      });
    };
  },
  hideExpenseForm: function(){ var f=document.getElementById('expenseForm'); if (f) { f.classList.add('hidden'); f.innerHTML=''; } },
  deleteExpense: function(e){
    var s=this;
    s.modal.confirm('Delete the expense <b>'+s.escapeHtml(e.Description)+'</b> ('+s.escapeHtml(s.money(e['Amount(GH₵)']))+')?').then(function(ok){
      if(!ok) return;
      s.call('deleteExpense',{eid:e.ExpenseID}).then(function(r){ if(r.success) s._reloadExpenses(); else s.modal.alert('❌ '+(r.message||'Delete failed.')); })
        .catch(function(err){ s.modal.alert('Error: '+err.message); });
    });
  },
  // Rebuilt without inline onclick strings (category names with quotes broke them).
  showCategoryManager: function(){
    var s=this, cats=(s._cache.expCats||[]).slice();
    var save=function(){ return s.call('saveExpenseCategories',{categories:cats}).then(function(r){ s._cache.expCats=(r&&r.categories)||cats.slice(); cats=s._cache.expCats.slice(); render(); }); };
    var render=function(){
      var list=document.getElementById('catList'); if (!list) return;
      list.innerHTML='';
      if (!cats.length) list.innerHTML='<li style="color:var(--text-muted);">No categories yet.</li>';
      cats.forEach(function(c,i){
        var li=document.createElement('li'); li.style.cssText='margin:6px 0;display:flex;gap:6px;align-items:center;';
        var inp=document.createElement('input'); inp.className='form-control'; inp.value=c; inp.style.margin='0';
        li.appendChild(inp);
        li.appendChild(s._btn('Save','btn-gold',function(){ var n=inp.value.trim(); if(!n||(cats.indexOf(n)>=0&&cats.indexOf(n)!==i)) return; cats[i]=n; save(); }));
        li.appendChild(s._btn('Del','btn-danger',function(){ cats.splice(i,1); save(); }));
        list.appendChild(li);
      });
    };
    s.modal.show('Expense Categories',
      '<ul id="catList" style="list-style:none;text-align:left;margin-bottom:10px;"></ul>'+
      '<div style="display:flex;gap:6px;"><input id="newCatInput" class="form-control" placeholder="New category" style="margin:0;"><button class="btn btn-sm" id="addCatBtn" style="padding:8px 16px;">Add</button></div>',
      [{text:'Close',cls:'btn-secondary',cb:function(){ if (document.getElementById('expTableWrap')) s.loadExpenses(document.getElementById('pageBody')); }}]);
    document.getElementById('addCatBtn').onclick=function(){
      var inp=document.getElementById('newCatInput'), n=inp.value.trim();
      if(!n||cats.indexOf(n)>=0) return;
      cats.push(n); inp.value=''; save();
    };
    render();
  },

  /* ═══ RESULTS ═══ */
  // FIX: validated on change instead of on every keystroke, which made it
  // impossible to type decimals like 45.5.
  validateScore: function(input,max){
    if (input.value==='') return;
    var v=parseFloat(input.value);
    if(isNaN(v)||v<0){ input.value=0; return; }
    if(v>max){ input.value=max; App.modal.alert('Maximum score is '+max+'.'); return; }
    input.value=Math.round(v*10)/10;
  },
  loadResults: function(el){
    var s=this;
    Promise.all([s.getClasses(),s.getStudents()]).then(function(res){
      var cl=res[0],students=res[1];
      el.innerHTML=
        '<div class="tab-bar">'+
          '<button class="btn tab-btn active" data-rtab="entry">📝 Score Entry</button>'+
          '<button class="btn tab-btn" data-rtab="broadsheet">📊 Class Broadsheet</button>'+
        '</div>'+
        '<div id="resEntryPanel"><div style="max-width:800px;margin:0 auto;">'+
          '<div class="promo-card" style="border-left:4px solid var(--blue);padding:18px;">'+
            '<h3 style="color:var(--blue);margin-bottom:6px;">📥 Whole class at once (template)</h3>'+
            '<p style="font-size:13px;">Download the Excel template for a class, type the scores (out of 100) and pick each student\'s conduct from the dropdown, then upload the same file. Names and IDs are locked so only scores and conduct can be changed. Blank cells keep what is already saved; uploading the same file again changes nothing.</p>'+
            '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px;">'+
              '<select id="tplClass" class="form-control" style="width:auto;min-width:160px;">'+s.classOptions(cl,false,null,'Select class')+'</select>'+
              '<button class="btn btn-secondary" id="tplDownload" style="margin:0;">⬇️ Download Excel template</button>'+
              '<input type="file" id="tplFile" accept=".xlsx,.csv" class="form-control" style="flex:1;min-width:180px;margin:0;">'+
              '<button class="btn" id="tplUpload" style="margin:0;">⬆️ Upload scores</button></div>'+
            '<div id="tplResult" style="margin-top:10px;font-size:13px;"></div></div>'+
          '<h4 style="margin:18px 0 8px;">Or one student at a time</h4>'+
          '<div style="display:flex;gap:12px;margin-bottom:10px;flex-wrap:wrap;"><select id="resClassFilter" class="form-control" style="width:auto;flex:1;">'+s.classOptions(cl,true)+'</select><select id="resStudentSelect" class="form-control" style="flex:2;">'+s.studentOptions(students,'All','Select Student')+'</select></div>'+
          '<button class="btn" id="loadSubjectsBtn">📚 Load Subjects</button>'+
          '<div id="weightDisplay" style="color:var(--gold);margin:12px 0;font-size:13px;"></div>'+
          '<div id="subjectsEntry"></div>'+
        '</div></div>'+
        '<div id="resBroadsheetPanel" style="display:none;">'+
          '<div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">'+
            '<select id="broadsheetClassFilter" class="form-control" style="width:auto;">'+s.classOptions(cl,false,null,'Select Class')+'</select>'+
            '<button class="btn" id="genBroadsheetBtn" style="margin-top:5px;">📊 Generate Broadsheet</button>'+
          '</div><div id="broadsheetResult"><div style="text-align:center;padding:40px;color:var(--text-muted);">Select a class and click <b>Generate Broadsheet</b>.</div></div>'+
        '</div>';
      el.querySelectorAll('[data-rtab]').forEach(function(b){ b.onclick=function(){
        el.querySelectorAll('[data-rtab]').forEach(function(x){ x.classList.toggle('active',x===b); });
        document.getElementById('resEntryPanel').style.display=b.dataset.rtab==='entry'?'':'none';
        document.getElementById('resBroadsheetPanel').style.display=b.dataset.rtab==='broadsheet'?'':'none';
      }; });
      document.getElementById('resClassFilter').onchange=function(){ document.getElementById('resStudentSelect').innerHTML=s.studentOptions(students,this.value,'Select Student'); document.getElementById('subjectsEntry').innerHTML=''; };
      document.getElementById('resStudentSelect').onchange=function(){ document.getElementById('subjectsEntry').innerHTML=''; };
      document.getElementById('loadSubjectsBtn').onclick=function(){ s._loadScoreEntry(this); };
      document.getElementById('tplDownload').onclick=function(){
        var cc=document.getElementById('tplClass').value; if (!cc) { s.modal.alert('Choose a class first.'); return; }
        var out=document.getElementById('tplResult');
        out.innerHTML='<span style="color:var(--text-muted);">⏳ Preparing the template…</span>';
        s.safeSubmit(this, function(){
          return Promise.all([s.call('getClassResultsTemplate',{classCode:cc}), s.loadExcelJS()]).then(function(res){
            out.innerHTML='';
            var t=res[0], ExcelJS=res[1];
            if (!t.success) { s.modal.alert('❌ '+t.message); return; }
            return s._buildResultsWorkbook(ExcelJS, t).then(function(buf){
              var url=URL.createObjectURL(new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
              var a=document.createElement('a'); a.href=url; a.download='Results_'+t.classCode+'_Term'+t.term+'_'+String(t.academicYear).replace('/','-')+'.xlsx';
              document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
            });
          });
        });
      };
      document.getElementById('tplUpload').onclick=function(){
        var cc=document.getElementById('tplClass').value, f=document.getElementById('tplFile').files[0], out=document.getElementById('tplResult');
        if (!cc) { s.modal.alert('Choose the class this file is for.'); return; }
        if (!f) { s.modal.alert('Choose the filled template.'); return; }
        var isCsv=/\.csv$/i.test(f.name);
        s.safeSubmit(this, function(){
          var read = isCsv ? f.text().then(function(txt){ return { csv: txt }; })
                           : Promise.all([f.arrayBuffer(), s.loadExcelJS()]).then(function(r){ return s._readResultsWorkbook(r[1], r[0]).then(function(rows){ return { rows: rows }; }); });
          return read.then(function(payload){
            payload.classCode=cc;
            return s.call('uploadClassResults',payload).then(function(r){
              var probs=(r.problems||[]);
              out.innerHTML='<div style="color:'+(r.success?'var(--green)':'var(--red)')+';font-weight:600;">'+(r.success?'✅ ':'❌ ')+s.escapeHtml(r.message)+'</div>'+
                ((r.missingSubjects||[]).length?'<div style="color:var(--gold);margin-top:4px;">Not in the file (left unchanged): '+s.escapeHtml(r.missingSubjects.join(', '))+'</div>':'')+
                (probs.length?'<ul style="color:var(--gold);margin:6px 0 0 18px;">'+probs.slice(0,30).map(function(x){ return '<li>'+s.escapeHtml(x)+'</li>'; }).join('')+(probs.length>30?'<li>…and '+(probs.length-30)+' more</li>':'')+'</ul>':'');
              if (r.success) document.getElementById('tplFile').value='';
            });
          }, function(e){ throw new Error('Could not read the file: '+(e&&e.message?e.message:e)+'. Please use the downloaded Excel template.'); });
        });
      };
      document.getElementById('genBroadsheetBtn').onclick=function(){ s._generateBroadsheet(this); };
    }).catch(function(e){ el.innerHTML=s.errHtml(e); });
  },
  // FIX: existing scores are now loaded into the form. Previously every
  // field showed 0, so re-saving a student wiped their earlier scores.
  _loadScoreEntry: function(b){
    var s=this, sid=document.getElementById('resStudentSelect').value;
    if(!sid){ s.modal.alert('Select a student first.'); return; }
    var st=s._cache.studentIdx&&s._cache.studentIdx[sid], classCode=st?st.Class:null;
    if (!classCode) { s.modal.alert('Could not find this student\'s class.'); return; }
    var se=document.getElementById('subjectsEntry'); se.innerHTML=s.spinner;
    b.disabled=true; b.textContent='⏳ Loading…';
    Promise.all([s.call('getGESSubjects',{classCode:classCode}),s.call('getScoreWeights'),s.call('getConductOptions',{},'conductOptions'),s.call('getStudentConduct',{sid:sid}),s.call('getStudentResults',{sid:sid})])
    .then(function(r){
      var subs=r[0]||[], w=r[1], conductOptions=r[2]||[], existingConduct=(r[3]&&r[3].conduct)||'', existing={};
      (r[4]||[]).forEach(function(x){ existing[x.subject]=x; });
      document.getElementById('weightDisplay').innerHTML='📊 '+s.escapeHtml(st.FullName)+' — enter raw scores out of <b>100</b>; they are scaled to <b>Class '+w.classWeight+'%</b> / <b>Exam '+w.examWeight+'%</b>.';
      if (!subs.length) { se.innerHTML='<p style="color:var(--gold);text-align:center;padding:20px;">No subjects are configured for this class. Add them under Settings → Subjects.</p>'; return; }
      se.innerHTML='';
      subs.forEach(function(sub, i){
        var ex=existing[sub], div=document.createElement('div'); div.className='subject-entry';
        div.innerHTML='<strong>📖 '+s.escapeHtml(sub)+(ex?' <span style="font-size:11px;color:var(--green);font-weight:400;">(saved: total '+ex.total+')</span>':'')+'</strong><div class="score-inputs">'+
          '<div style="flex:1;"><label style="font-size:11px;color:var(--text-muted);">Class Score (out of 100)</label><input class="form-control class-score" data-idx="'+i+'" type="number" step="0.5" min="0" max="100" value="'+(ex?ex.rawClass:'')+'" placeholder="0"></div>'+
          '<div style="flex:1;"><label style="font-size:11px;color:var(--text-muted);">Exam Score (out of 100)</label><input class="form-control exam-score" data-idx="'+i+'" type="number" step="0.5" min="0" max="100" value="'+(ex?ex.rawExam:'')+'" placeholder="0"></div></div>';
        se.appendChild(div);
      });
      se.querySelectorAll('.class-score,.exam-score').forEach(function(inp){ inp.onchange=function(){ s.validateScore(inp,100); }; });
      var saveBtn=document.createElement('button'); saveBtn.className='btn'; saveBtn.style.cssText='width:100%;margin-top:15px;'; saveBtn.textContent='💾 Save All Scores';
      se.appendChild(saveBtn);
      var conductDiv=document.createElement('div');
      conductDiv.style.cssText='margin-top:20px;padding:18px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;';
      conductDiv.innerHTML='<h4 style="margin:0 0 6px;color:var(--gold);">🧭 Conduct</h4>'+
        '<p style="color:var(--text-muted);font-size:12px;margin:0 0 10px;">Chosen by the teacher. If none is chosen, the report card leaves a blank line to write on.</p>'+
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;"><select id="conductSelect" class="form-control" style="width:auto;flex:1;min-width:180px;">'+
          '<option value="">-- Not selected --</option>'+conductOptions.map(function(c){ return '<option value="'+s.escapeHtml(c)+'"'+(c===existingConduct?' selected':'')+'>'+s.escapeHtml(c)+'</option>'; }).join('')+
        '</select><button class="btn" id="saveConductBtn" style="margin-top:0;">💾 Save Conduct</button></div>'+
        '<div id="conductStatus" style="margin-top:8px;font-size:12px;color:var(--text-muted);">'+(existingConduct?'Current: '+s.escapeHtml(existingConduct):'')+'</div>';
      se.appendChild(conductDiv);
      // Third Term: Promote / Repeat for this student (shown on the report card)
      var promoDiv=document.createElement('div');
      promoDiv.style.cssText='margin-top:14px;padding:18px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;';
      se.appendChild(promoDiv);
      s.call('getPromotionDecision',{sid:sid}).then(function(pd){
        if (!pd || !pd.success || pd.term!==3) { promoDiv.remove(); return; }
        var autoTxt=(pd.automatic==='Repeat'?'Repeat':'Promote')+(pd.passMark>0?' (average '+pd.average.toFixed(1)+'% vs pass mark '+pd.passMark+'%)':' (no pass mark set — everyone is promoted)');
        promoDiv.innerHTML='<h4 style="margin:0 0 6px;color:var(--blue);">🎓 Promotion (Third Term)</h4>'+
          '<p style="color:var(--text-muted);font-size:12px;margin:0 0 10px;">Shown at the top of the report card. Automatic: <b>'+s.escapeHtml(autoTxt)+'</b>.</p>'+
          '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;"><select id="promoSelect" class="form-control" style="width:auto;flex:1;min-width:180px;">'+
            [['Auto','Automatic ('+(pd.automatic==='Repeat'?'Repeat':'Promote')+')'],['Promote','Promote'],['Repeat','Repeat']].map(function(o){ return '<option value="'+o[0]+'"'+((pd.manual||'Auto')===o[0]?' selected':'')+'>'+o[1]+'</option>'; }).join('')+
          '</select><button class="btn" id="savePromoBtn" style="margin-top:0;">💾 Save</button></div><div id="promoStatus" style="margin-top:8px;font-size:12px;color:var(--text-muted);"></div>';
        document.getElementById('savePromoBtn').onclick=function(){
          var v=document.getElementById('promoSelect').value, st=document.getElementById('promoStatus');
          s.safeSubmit(this, function(){
            return s.call('savePromotionDecision',{sid:sid,decision:v}).then(function(r){ st.textContent=(r.success?'✅ ':'❌ ')+r.message; });
          });
        };
      }).catch(function(){ promoDiv.remove(); });
      saveBtn.onclick=function(){
        s.safeSubmit(saveBtn, function(){
          var scores=subs.map(function(sub,i){
            return {subject:sub, classScore:parseFloat(se.querySelector('.class-score[data-idx="'+i+'"]').value)||0, examScore:parseFloat(se.querySelector('.exam-score[data-idx="'+i+'"]').value)||0};
          });
          return s.call('recordSubjectScoreBatch',{studentID:sid,scores:scores}).then(function(res){ return s.modal.alert((res.success?'✅ ':'❌ ')+res.message); });
        });
      };
      document.getElementById('saveConductBtn').onclick=function(){
        var cbtn=this, val=document.getElementById('conductSelect').value, statusEl=document.getElementById('conductStatus');
        if(!val){ s.modal.alert('Please select a conduct rating first.'); return; }
        s.safeSubmit(cbtn, function(){
          return s.call('saveStudentConduct',{sid:sid,conduct:val}).then(function(res){ statusEl.textContent=res.success?'✅ Current: '+val:'❌ '+res.message; });
        });
      };
    }).catch(function(e){ se.innerHTML=s.errHtml(e); })
      .then(function(){ b.disabled=false; b.textContent='📚 Load Subjects'; });
  },
  _generateBroadsheet: function(btn){
    var s=this, cc=document.getElementById('broadsheetClassFilter').value, wrap=document.getElementById('broadsheetResult');
    if (!cc) { s.modal.alert('Please select a class first.'); return; }
    btn.disabled=true; btn.textContent='⏳ Generating…'; wrap.innerHTML=s.spinner;
    s.call('getClassBroadsheet',{classCode:cc}).then(function(bres){
      if (!bres||!bres.success) { wrap.innerHTML='<p style="color:var(--red);text-align:center;padding:20px;">'+s.escapeHtml((bres&&bres.message)||'Error generating broadsheet.')+'</p>'; return; }
      if (!bres.rows.length) { wrap.innerHTML='<p style="color:var(--text-muted);text-align:center;padding:40px;">No active students found in this class.</p>'; return; }
      if (!bres.subjects.length) { wrap.innerHTML='<p style="color:var(--gold);text-align:center;padding:40px;">No subjects configured for this class category yet.</p>'; return; }
      wrap.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">'+
          '<h4 style="margin:0;">'+s.escapeHtml(bres.className)+' — Broadsheet <small style="color:var(--text-muted);font-weight:400;">('+bres.rows.length+' students)</small></h4>'+
          '<button class="btn" id="printBroadsheetBtn" style="margin-top:0;">🖨️ Print Broadsheet</button></div><div id="broadsheetTableWrap"></div>';
      s._renderBroadsheetTable(document.getElementById('broadsheetTableWrap'), bres);
      document.getElementById('printBroadsheetBtn').onclick=function(){
        s.getConfig().then(function(cfg){
          document.getElementById('printContent').innerHTML=s._buildBroadsheetHTML(bres,cfg);
          App.printContent('@page { size: A4 landscape; margin: 10mm; }');
        }).catch(function(e){ s.modal.alert('Error: '+e.message); });
      };
    }).catch(function(e){ wrap.innerHTML=s.errHtml(e); })
      .then(function(){ btn.disabled=false; btn.textContent='📊 Generate Broadsheet'; });
  },
  _bsCell: function(sc){ return (sc && sc.grade !== null && sc.grade !== undefined) ? sc.total : '-'; },
  _renderBroadsheetTable: function(container, data) {
    var s=this;
    var rows=data.rows.map(function(row,i){
      var tr=document.createElement('tr');
      tr.insertCell().textContent=i+1;
      var tdName=tr.insertCell(); tdName.textContent=row.studentName; tdName.style.fontWeight='600';
      data.subjects.forEach(function(sub){ var td=tr.insertCell(); td.style.textAlign='center'; td.textContent=s._bsCell(row.scores[sub]); });
      var a=tr.insertCell(); a.textContent=row.grandTotal; a.style.cssText='text-align:center;font-weight:700;color:var(--green);';
      var b=tr.insertCell(); b.textContent=row.average.toFixed(1)+'%'; b.style.textAlign='center';
      var c=tr.insertCell(); c.textContent=s._ordinal(row.position); c.style.cssText='text-align:center;font-weight:700;color:var(--gold);';
      if (data.term===3) { var d=tr.insertCell(); d.textContent=row.decision==='Repeat'?'Repeat':'Promote'; d.style.cssText='text-align:center;font-weight:700;color:'+(row.decision==='Repeat'?'var(--red)':'var(--green)')+';'; }
      return tr;
    });
    container.innerHTML=''; container.appendChild(s._buildTable(['#','Student Name'].concat(data.subjects).concat(['Grand Total','Average','Position']).concat(data.term===3?['Decision']:[]),rows));
  },
  _buildBroadsheetHTML: function(data, cfg) {
    var s=this, schoolName=(cfg&&cfg.schoolName)||'', printedDate=new Date().toLocaleDateString('en-GB');
    var t3=data.term===3, totalCols=2+data.subjects.length+3+(t3?1:0);
    var fontSize=totalCols<=9?12:totalCols<=13?10.5:totalCols<=17?9:8, cellPad=totalCols<=13?'6px 8px':'4px 5px';
    var td=function(v,extra){ return '<td style="padding:'+cellPad+';border-bottom:1px solid #ddd;font-size:'+fontSize+'px;'+(extra||'')+'">'+v+'</td>'; };
    var headerRowsHtml='<tr><th colspan="'+totalCols+'" style="padding:0;border:none;background:#fff;">'+
        '<div style="text-align:center;padding:8px 0 10px;border-bottom:2px solid #006B3F;">'+
          '<div style="color:#006B3F;font-size:17px;font-weight:700;text-transform:uppercase;">'+s.escapeHtml(schoolName)+'</div>'+
          '<div style="font-size:12px;color:#333;font-weight:700;">Class Broadsheet — '+s.escapeHtml(data.className)+'</div>'+
          '<div style="font-size:10.5px;color:#555;">'+s.escapeHtml(s.TERM_NAMES[data.term]||('Term '+data.term))+' | '+s.escapeHtml(data.academicYear)+' | Printed: '+printedDate+'</div>'+
        '</div></th></tr>'+
      '<tr>'+['#','Student Name'].concat(data.subjects).concat(['Grand Total','Average','Position']).concat(t3?['Decision']:[])
        .map(function(h,i){ return '<th style="background:#006B3F;color:white;padding:'+cellPad+';text-align:'+(i<2?'left':'center')+';white-space:nowrap;font-size:'+fontSize+'px;">'+s.escapeHtml(h)+'</th>'; }).join('')+'</tr>';
    var rowsHtml=data.rows.map(function(row,i){
      var cells=[td(i+1),td(s.escapeHtml(row.studentName))];
      data.subjects.forEach(function(sub){ cells.push(td(s._bsCell(row.scores[sub]),'text-align:center;')); });
      cells.push(td(row.grandTotal,'text-align:center;font-weight:700;'));
      cells.push(td(row.average.toFixed(1)+'%','text-align:center;'));
      cells.push(td(s._ordinal(row.position),'text-align:center;font-weight:700;'));
      if (t3) cells.push(td(row.decision==='Repeat'?'Repeat':'Promote','text-align:center;font-weight:700;color:'+(row.decision==='Repeat'?'#CE1126':'#006B3F')+';'));
      return '<tr class="bcast-row" style="background:'+(i%2===0?'#fff':'#fafafa')+';page-break-inside:avoid;">'+cells.join('')+'</tr>';
    }).join('');
    var sig=function(role){ return '<div style="width:260px;"><div style="border-top:1px solid #333;margin-top:40px;padding-top:6px;font-size:12px;">'+role+' — Signature</div><div style="margin-top:22px;border-top:1px solid #333;padding-top:6px;font-size:12px;">Name</div><div style="margin-top:22px;border-top:1px solid #333;padding-top:6px;font-size:12px;">Date</div></div>'; };
    return '<div style="max-width:100%;margin:0 auto;background:#fff;color:#1a1a1a;font-family:Georgia,serif;">'+
      '<style>@media print { .broadsheet-print-table thead { display: table-header-group; } .broadsheet-print-table tr.bcast-row { page-break-inside: avoid; } }</style>'+
      '<table class="broadsheet-print-table" style="width:100%;border-collapse:collapse;"><thead>'+headerRowsHtml+'</thead><tbody>'+rowsHtml+'</tbody></table>'+
      '<div style="margin-top:40px;display:flex;justify-content:space-between;padding:0 10px;">'+sig('Class Teacher')+sig('Headteacher')+'</div></div>';
  },

  /* ═══ REPORT CARD ═══
     FIX: subject positions, "Next Term Begins" and "Promoted To" were
     computed by the server but never shown on the card. */
  _buildReportCardHTML: function(data) {
    var s=this, E=function(v){ return s.escapeHtml(v); };
    var crest=data.schoolCrest?'<img src="'+E(data.schoolCrest)+'" style="width:100%;height:100%;object-fit:contain;padding:4px;background:white;">':'<span style="font-size:40px;">🏫</span>';
    var photo=data.studentPhoto?'<img src="'+E(data.studentPhoto)+'" style="width:100%;height:100%;object-fit:cover;">':'<span style="font-size:32px;color:#ccc;">📷</span>';
    var box=function(label,val){ return '<div style="background:#f9f9f9;padding:14px;border-radius:10px;"><strong style="display:block;font-size:11px;color:#555;">'+label+'</strong>'+val+'</div>'; };
    // Key facts strip at the TOP: [Promoted to / Repeated (Third Term)] · Next Term Begins · Outstanding Fees
    var fact=function(label,val,col){ return '<div style="flex:1;min-width:0;padding:10px 14px;border-left:4px solid '+col+';background:#fff;"><div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#666;font-family:Arial,sans-serif;">'+label+'</div><div style="font-size:15px;font-weight:700;color:'+col+';margin-top:2px;">'+val+'</div></div>'; };
    var facts=[];
    if (data.promotion) {
      var pr=data.promotion;
      facts.push(pr.decision==='Repeat' ? fact('Repeated', E(pr.detail), '#CE1126')
               : pr.label==='Completed' ? fact('Completed', E(pr.detail), '#006B3F')
               : fact('Promoted to', E(pr.detail), '#006B3F'));
    }
    facts.push(fact('Next term begins', data.nextTermBegins ? E(s.niceDate(data.nextTermBegins)) : '<span style="color:#777;font-weight:400;font-style:italic;">To be announced</span>', '#1f3b57'));
    if (data.feeBalance !== null && data.feeBalance !== undefined) {
      var fb=parseFloat(data.feeBalance)||0;
      facts.push(fact('Outstanding fees', fb > 0.004 ? 'GH₵ '+fb.toFixed(2) : fb < -0.004 ? 'Nil (GH₵ '+(-fb).toFixed(2)+' credit)' : 'Nil — fully paid', fb > 0.004 ? '#CE1126' : '#006B3F'));
    }
    var factsRow='<div style="display:flex;gap:2px;background:#e5e9e6;border:1px solid #d4dbd6;border-radius:8px;overflow:hidden;margin-bottom:18px;">'+facts.join('')+'</div>';
    return '<div style="max-width:800px;margin:0 auto;background:#fff;color:#1a1a1a;border:3px solid #006B3F;padding:30px;border-radius:12px;font-family:Georgia,serif;">'+
      '<div style="height:6px;background:linear-gradient(90deg,#CE1126 33%,#FCD116 33%,#FCD116 66%,#006B3F 66%);margin:-30px -30px 25px -30px;"></div>'+
      '<div style="display:flex;align-items:center;margin-bottom:25px;gap:20px;"><div style="width:100px;height:100px;border-radius:8px;overflow:hidden;border:2px solid #ddd;background:#f9f9f9;display:flex;align-items:center;justify-content:center;flex-shrink:0;">'+crest+'</div>'+
      '<div style="flex:1;text-align:center;"><h2 style="color:#006B3F;font-size:22px;font-weight:700;margin:0;text-transform:uppercase;">'+E(data.schoolName)+'</h2><p style="color:#CE1126;font-style:italic;font-size:14px;margin:0;">'+E(data.schoolMotto)+'</p><p style="font-size:12px;color:#333;margin:0;">'+E(data.schoolAddress)+'</p><p style="font-size:13px;font-weight:700;margin:6px 0 0;letter-spacing:1px;">TERMINAL REPORT</p></div>'+
      '<div style="width:80px;height:100px;border:1px solid #333;border-radius:4px;overflow:hidden;background:#f9f9f9;display:flex;align-items:center;justify-content:center;flex-shrink:0;">'+photo+'</div></div>'+
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;background:#f0f8f0;padding:16px;border-radius:10px;margin-bottom:14px;">'+
        [['Name',data.student.FullName],['ID',data.student.StudentID],['Class',data.student.Class],['Gender',data.student.Gender],['Year',data.academicYear],['Term',s.TERM_NAMES[data.term]||('Term '+data.term)]]
        .map(function(f){ return '<div style="font-size:13px;"><strong style="display:block;font-size:11px;color:#555;">'+f[0]+'</strong>'+E(f[1])+'</div>'; }).join('')+'</div>'+
      factsRow+
      '<table style="width:100%;border-collapse:collapse;margin-bottom:25px;font-size:13px;"><thead><tr>'+
        ['Subject','Class ('+data.scoreWeights.classWeight+'%)','Exam ('+data.scoreWeights.examWeight+'%)','Total','Position','Grade'].map(function(h,i){ return '<th style="background:#006B3F;color:white;padding:9px;text-align:'+(i===0?'left':'center')+';">'+h+'</th>'; }).join('')+'</tr></thead><tbody>'+
        data.subjects.map(function(sub,i){
          return '<tr style="background:'+(i%2===0?'#fff':'#fafafa')+'"><td style="padding:7px;">'+E(sub.name)+'</td>'+
            ['classScore','examScore','total'].map(function(k){ return '<td style="text-align:center;">'+E(sub[k])+'</td>'; }).join('')+
            '<td style="text-align:center;">'+s._ordinal(sub.position)+'</td>'+
            '<td style="text-align:center;"><span style="display:inline-block;padding:3px 10px;border-radius:20px;font-weight:700;font-size:11px;color:white;background:'+App.gradeColor(sub.grade)+';">'+sub.grade+' – '+E(sub.descriptor)+'</span></td></tr>';
        }).join('')+'</tbody></table>'+
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:15px;background:#f0f8f0;padding:16px;border-radius:10px;text-align:center;margin-bottom:20px;">'+
        '<div><strong style="display:block;font-size:11px;color:#555;">Total</strong>'+(parseFloat(data.totalScore)||0).toFixed(1)+'</div>'+
        '<div><strong style="display:block;font-size:11px;color:#555;">Average</strong>'+(parseFloat(data.average)||0).toFixed(1)+'%</div>'+
        '<div><strong style="display:block;font-size:11px;color:#555;">Position</strong>'+(data.rank.rank?s._ordinal(data.rank.rank)+' out of '+data.rank.outOf:'—')+'</div></div>'+
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:15px;margin-bottom:15px;">'+
        box('Attendance', data.attendance&&data.attendance.total?data.attendance.present+' / '+data.attendance.total+' days':'No records')+
        box('Conduct', data.conduct ? E(data.conduct) : '<span style="display:inline-block;width:85%;border-bottom:1px dotted #999;height:18px;"></span>')+
        box('Remark', '<em>'+E(data.teacherRemark)+'</em>')+'</div>'+
      '<div style="display:flex;justify-content:space-between;margin-top:40px;"><div style="text-align:center;width:150px;"><div style="border-top:1px solid #333;padding-top:8px;">Class Teacher</div></div><div style="text-align:center;width:150px;"><div style="border-top:1px solid #333;padding-top:8px;">Head Teacher</div></div></div></div>';
  },
  loadReport: function(el){
    var s=this;
    Promise.all([s.getClasses(),s.getStudents()]).then(function(res){
      var cl=res[0],students=res[1];
      el.innerHTML='<div style="max-width:900px;margin:0 auto;">'+
          '<div style="display:flex;gap:12px;margin-bottom:10px;flex-wrap:wrap;"><select id="repClassFilter" class="form-control" style="width:auto;flex:1;">'+s.classOptions(cl,true)+'</select><select id="repStudentSelect" class="form-control" style="flex:2;">'+s.studentOptions(students,'All','Select Student')+'</select></div>'+
          '<button class="btn" id="viewReportBtn">📄 View Report Card</button>'+
          '<div class="promo-card" style="border-left:4px solid var(--blue);margin-top:20px;">'+
            '<h3 style="color:var(--blue);">🖨️ Bulk Print Report Cards</h3>'+
            '<p>Generate report cards for a whole class (or every active student), one card per printed page.</p>'+
            '<div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;align-items:center;">'+
              '<select id="bulkRepClassFilter" class="form-control" style="width:auto;">'+s.classOptions(cl,true)+'</select>'+
              '<button class="btn" id="bulkPrintReportsBtn" style="margin-top:5px;">🖨️ Generate &amp; Print</button>'+
              '<span id="bulkRepStatus" style="color:var(--text-muted);font-size:13px;"></span>'+
            '</div></div><div id="reportContent" style="margin-top:20px;"></div></div>';
      document.getElementById('repClassFilter').onchange=function(){ document.getElementById('repStudentSelect').innerHTML=s.studentOptions(students,this.value,'Select Student'); };
      document.getElementById('viewReportBtn').onclick=function(){
        var sid=document.getElementById('repStudentSelect').value; if(!sid){ s.modal.alert('Select a student first.'); return; }
        var b=this; b.disabled=true; b.textContent='⏳ Generating…';
        s.call('generateReportCard',{sid:sid}).then(function(data){
          if(!data||data.error){ s.modal.alert((data&&data.message)||'Could not generate the report card.'); return; }
          var rHTML=s._buildReportCardHTML(data), rc=document.getElementById('reportContent');
          var pb=document.createElement('button'); pb.className='btn'; pb.textContent='🖨️ Print Report Card'; pb.style.cssText='display:block;width:100%;max-width:300px;margin:0 auto 15px;';
          pb.onclick=function(){ document.getElementById('printContent').innerHTML=rHTML; App.printContent(); };
          rc.innerHTML=''; rc.appendChild(pb); var wrapper=document.createElement('div'); wrapper.className='report-preview'; wrapper.innerHTML=rHTML; rc.appendChild(wrapper);
        }).catch(function(e){ s.modal.alert('Error: '+e.message); }).then(function(){ b.disabled=false; b.textContent='📄 View Report Card'; });
      };
      // One class per request keeps each response small (photos are large),
      // so "All classes" works for any school size.
      document.getElementById('bulkPrintReportsBtn').onclick=function(){
        var btn=this, cc=document.getElementById('bulkRepClassFilter').value, status=document.getElementById('bulkRepStatus');
        var codes = cc==='All' ? cl.map(function(c){ return c.code; }) : [cc];
        var html=[], total=0, school=null, i=0;
        btn.disabled=true; btn.textContent='⏳ Generating…';
        var finish=function(){ btn.disabled=false; btn.textContent='🖨️ Generate & Print'; };
        var next=function(){
          if (i>=codes.length) {
            if (!total) { status.textContent=''; s.modal.alert('No active students found for that selection.'); finish(); return; }
            document.getElementById('printContent').innerHTML=html.join('');
            status.textContent='✅ '+total+' report card(s) ready.';
            finish(); App.printContent(); return;
          }
          var code=codes[i++];
          status.textContent='Generating '+code+(codes.length>1?' ('+i+' of '+codes.length+')':'')+'…';
          s.call('generateReportCardsBatch',{classCode:code}).then(function(res){
            if (!res||!res.success) throw new Error((res&&res.message)||'Failed to generate report cards for '+code+'.');
            school=res.school||school||{};
            res.reportCards.forEach(function(d){ html.push('<div class="report-card-page">'+s._buildReportCardHTML(Object.assign({}, school, d))+'</div>'); });
            total+=res.count; next();
          }).catch(function(e){ status.textContent=''; s.modal.alert('❌ '+e.message); finish(); });
        };
        next();
      };
    }).catch(function(e){ el.innerHTML=s.errHtml(e); });
  },

  /* ═══ ATTENDANCE: Present / Absent only ═══
     Saved statuses load for the chosen date; students not yet marked start
     as Present. (Older "Late" records count as Present, "Excused" as Absent.) */
  loadAttendance: function(el){
    var s=this;
    Promise.all([s.getClasses(),s.getStudents()]).then(function(res){
      var cl=res[0],allStu=res[1];
      el.innerHTML='<div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap;align-items:flex-end;">'+
          '<div><label>Class</label><select id="attClass" class="form-control" style="width:auto;min-width:160px;">'+s.classOptions(cl,true,s._attClass||(cl[0]&&cl[0].code)||'All')+'</select></div>'+
          '<div><label>Date</label><input id="attDate" class="form-control" type="date" value="'+s.todayYMD()+'" max="'+s.todayYMD()+'" style="width:170px;"></div>'+
          '<button class="btn btn-secondary" id="markAllPresentBtn" style="margin:5px 0;">✓ Mark all Present</button></div>'+
        '<div id="attSummary" style="display:flex;gap:24px;flex-wrap:wrap;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:12px 16px;margin-bottom:10px;"></div>'+
        '<div id="attNote" style="font-size:12px;color:var(--text-muted);margin-bottom:8px;"></div>'+
        '<div id="attList"></div>'+
        '<div class="sticky-save" style="position:sticky;bottom:0;background:var(--bg-card);border-top:1px solid var(--border);padding:12px 0;margin-top:8px;display:flex;justify-content:flex-end;">'+
          '<button class="btn" id="saveAttBtn" style="margin:0;">💾 Save Attendance</button></div>';
      var rows=[];
      var btnCss=function(on,col){ return 'padding:8px 16px;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;min-width:84px;border:1px solid '+(on?col:'var(--border)')+';background:'+(on?'transparent':'var(--bg-input)')+';color:'+(on?col:'var(--text-secondary)')+';'; };
      var paint=function(i){
        var card=document.getElementById('att'+i); if (!card) return;
        card.querySelector('.att-p').style.cssText=btnCss(rows[i].status==='Present','var(--green)');
        card.querySelector('.att-a').style.cssText=btnCss(rows[i].status==='Absent','var(--red)');
      };
      var summary=function(){
        var p=rows.filter(function(r){ return r.status==='Present'; }).length;
        document.getElementById('attSummary').innerHTML=[['Students',rows.length,'var(--text-primary)'],['Present',p,'var(--green)'],['Absent',rows.length-p,'var(--red)']]
          .map(function(d){ return '<div><div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);">'+d[0]+'</div><div style="font-size:22px;font-weight:800;color:'+d[2]+';">'+d[1]+'</div></div>'; }).join('');
      };
      var render=function(){
        var cf=s._attClass=document.getElementById('attClass').value, date=document.getElementById('attDate').value, list=document.getElementById('attList');
        var students=cf==='All'?allStu:allStu.filter(function(st){ return st.Class===cf; });
        list.innerHTML=s.spinner; rows=[];
        s.call('getAttendanceForDate',{date:date}).then(function(existing){
          existing=existing||{};
          var saved=students.filter(function(st){ return existing[st.StudentID]; }).length;
          document.getElementById('attNote').textContent = saved ? 'Showing what was saved for this date ('+saved+' student'+(saved===1?'':'s')+'). Anyone not yet marked starts as Present.' : 'Nothing saved yet for this date — everyone starts as Present. Tap Absent for those who are not in school.';
          rows=students.map(function(st){
            var v=existing[st.StudentID];
            return { sid:st.StudentID, name:st.FullName, cls:st.Class, status: (v==='Absent'||v==='Excused') ? 'Absent' : 'Present' };
          });
          if (!rows.length) { list.innerHTML='<p style="color:var(--text-muted);text-align:center;padding:30px;">No students in this class.</p>'; summary(); return; }
          var showClass=cf==='All';
          list.innerHTML=rows.map(function(r,i){
            return '<div id="att'+i+'" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:10px 14px;margin-bottom:8px;">'+
              '<div style="font-weight:600;color:var(--text-primary);min-width:160px;">'+s.escapeHtml(r.name)+(showClass?' <small style="color:var(--text-muted);font-weight:400;">'+s.escapeHtml(r.cls)+'</small>':'')+'</div>'+
              '<div style="display:flex;gap:8px;"><button class="att-p" data-i="'+i+'">Present</button><button class="att-a" data-i="'+i+'">Absent</button></div></div>';
          }).join('');
          list.querySelectorAll('.att-p').forEach(function(b){ b.onclick=function(){ rows[+b.dataset.i].status='Present'; paint(+b.dataset.i); summary(); }; });
          list.querySelectorAll('.att-a').forEach(function(b){ b.onclick=function(){ rows[+b.dataset.i].status='Absent'; paint(+b.dataset.i); summary(); }; });
          rows.forEach(function(r,i){ paint(i); }); summary();
        }).catch(function(e){ list.innerHTML=s.errHtml(e); });
      };
      document.getElementById('attClass').onchange=render;
      document.getElementById('attDate').onchange=render;
      document.getElementById('markAllPresentBtn').onclick=function(){ rows.forEach(function(r,i){ r.status='Present'; paint(i); }); summary(); };
      document.getElementById('saveAttBtn').onclick=function(){
        if (!rows.length) { s.modal.alert('No students to save.'); return; }
        var recs=rows.map(function(r){ return { studentID:r.sid, status:r.status }; });
        s.safeSubmit(this, function(){
          return s.call('markAttendanceBatch',{date:document.getElementById('attDate').value,records:recs}).then(function(res){ return s.modal.alert((res.success?'✅ ':'❌ ')+res.message); });
        });
      };
      render();
    }).catch(function(e){ el.innerHTML=s.errHtml(e); });
  },

  /* ═══ PROMOTION ═══ */
  loadPromotion: function(el){
    var s=this;
    s._cache.config=null;
    s.getConfig().then(function(cfg){
      var currentTerm=parseInt(cfg.currentTerm,10)||1, currentYear=cfg.currentAcademicYear||'';
      var termLabel=s.TERM_NAMES[currentTerm], nextTerm=(currentTerm%3)+1, nextTermLabel=s.TERM_NAMES[nextTerm];
      var E=function(v){ return s.escapeHtml(v); };
      el.innerHTML=
        '<div class="promo-card" style="border-left:4px solid var(--red);">'+
          '<h3 style="color:var(--red);">⚡ Step 1 — Term Rollover</h3>'+
          '<p>Currently on <strong style="color:var(--blue);">'+E(termLabel)+(currentYear?' — '+E(currentYear):'')+'</strong>. Rollover moves to <strong style="color:var(--blue);">'+E(nextTermLabel)+'</strong>, copies fee items forward and carries each student\'s balance over as arrears (or credit).'+
          (currentTerm===3?' Because this is Third Term, the academic year also advances and students in the final class are marked <b>Graduated</b>.':'')+'</p>'+
          '<ul class="warning-list" style="margin-top:12px;">'+
            '<li>The current term cannot be re-opened after rollover.</li>'+
            '<li>Print report cards for '+E(termLabel)+' BEFORE rolling over — results stay with this term.</li>'+
            '<li>Record ALL payments for '+E(termLabel)+' first.</li>'+
          '</ul>'+
          '<button class="btn btn-danger" id="rolloverBtn" style="margin-top:18px;font-size:15px;padding:12px 28px;">⚡ Rollover to '+E(nextTermLabel)+'</button>'+
        '</div>'+
        '<div class="promo-card" style="border-left:4px solid var(--gold);">'+
          '<h3 style="color:var(--gold);">🎓 Step 2 — Promote All Students</h3>'+
          '<p>Moves every active student up one class — except students marked <b>Repeated</b> on their Third Term report, who stay in their class. Run this once, at the start of the new academic year (right after the Third Term rollover). It can only run once per academic year.</p>'+
          (currentTerm!==1?'<p style="color:var(--gold);margin-top:8px;">⚠️ You are in '+E(termLabel)+'. Promotion is normally done in First Term after the year rollover.</p>':'')+
          '<button class="btn btn-gold" id="promoteBtn" style="margin-top:18px;font-size:15px;padding:12px 28px;">🎓 Promote All Students</button>'+
        '</div>';
      document.getElementById('promoteBtn').onclick=function(){
        s.showDangerConfirm({
          icon:'🎓', title:'Promote All Students?', subtitle:'Every active student will be moved up one class immediately.',
          warnings:['Students in the final class will be marked Graduated.','This can only run once per academic year ('+currentYear+').','Moving students back must be done manually.'],
          keyword:'PROMOTE', confirmLabel:'🎓 Yes, Promote All', confirmColor:'var(--gold)',
          onConfirm:function(){
            var btn=document.getElementById('promoteBtn'); btn.disabled=true; btn.textContent='⏳ Promoting…';
            s.call('promoteAllClasses').then(function(res){
              if (!res||!res.success) { s.modal.alert('❌ '+((res&&res.message)||'Promotion failed.')); return; }
              s.invalidateStudents(); s._feeOvData=[];
              var rows=(res.summary||[]).map(function(r){ return { label:r.from+'  →  '+r.to, value:(r.promoted+r.graduated)+' students'+(r.repeated?' · '+r.repeated+' repeating':''), color:r.to==='Graduated'?'var(--teal)':'var(--green)' }; });
              rows.unshift({ label:'Classes processed', value:rows.length, color:'var(--blue)' });
              s.showResultModal({ icon:'🎓', title:'Promotion Complete!', rows:rows });
            }).catch(function(e){ s.modal.alert('❌ Error: '+e.message); })
              .then(function(){ btn.disabled=false; btn.textContent='🎓 Promote All Students'; });
          }
        });
      };
      document.getElementById('rolloverBtn').onclick=function(){
        s.showDangerConfirm({
          icon:'⚡', title:'Rollover to '+nextTermLabel+'?', subtitle:termLabel+' will be closed permanently.',
          warnings:['All unpaid balances become arrears in the new term.','Fee items are copied forward — review them afterwards.',
            currentTerm===3?'Academic year advances from '+currentYear+' and final-class students graduate.':'Academic year ('+currentYear+') stays the same.',
            'Ensure ALL payments for '+termLabel+' are recorded.'],
          keyword:'ROLLOVER', confirmLabel:'⚡ Yes, Rollover Now', confirmColor:'var(--red)',
          options:[{ key:'archive', checked:true, label:'Also archive '+termLabel+' straight after (recommended)',
                     hint:'Moves its attendance, results and canteen rows to the archive spreadsheet so the system stays fast. Balances are carried forward.' }],
          onConfirm:function(chosen){
            var btn=document.getElementById('rolloverBtn'); btn.disabled=true; btn.textContent='⏳ Rolling over…';
            s.call('processRollover').then(function(res){
              if (res && res.success) {
                s._cache.config=null; s.invalidateStudents(); s._feeOvData=[];
                var archiveRow=null;
                var show=function(){ s.showResultModal({ icon:'✅', title:'Rollover Complete!', rows:[
                  { label:'New Term', value:s.TERM_NAMES[res.newTerm]||('Term '+res.newTerm), color:'var(--blue)' },
                  { label:'Academic Year', value:res.newAcademicYear, color:'var(--blue)' },
                  { label:'Students Rolled Over', value:res.processedCount, color:'var(--green)' },
                  { label:'Students Graduated', value:res.graduatedCount, color:'var(--teal)' },
                  { label:'Fee Items Copied', value:res.feeItemsCopied, color:'var(--gold)' },
                  { label:'Total Arrears Carried', value:s.money(res.totalRolloverAmount), color:'var(--orange)' },
                  { label:'Overpayment Credits', value:s.money(res.totalOverpaid), color:'var(--teal)' }
                ].concat(archiveRow?[archiveRow]:[]), onClose:function(){ location.reload(); } }); };
                if (!chosen || !chosen.archive) { show(); return; }
                btn.textContent='⏳ Archiving '+termLabel+'…';
                s.modal.show('🗄️ Archiving '+s.escapeHtml(termLabel), '<div id="rollArchProg">Starting…</div><p style="font-size:12px;color:var(--text-muted);margin-top:8px;">The rollover is done. Please keep this page open for a minute or two.</p>', []);
                s.runArchive(function(t){ var el=document.getElementById('rollArchProg'); if (el) el.textContent=t; }).then(function(moved){
                  s.modal.close(); archiveRow={ label:'Rows Archived', value:moved.toLocaleString(), color:'var(--green)' }; show();
                }).catch(function(e){
                  s.modal.close(); archiveRow={ label:'Archiving', value:'Not finished — Settings → Data', color:'var(--red)' }; show();
                });
              } else { s.modal.alert('❌ '+((res&&res.message)||'Rollover failed.')); btn.disabled=false; btn.textContent='⚡ Rollover to '+nextTermLabel; }
            }).catch(function(e){ s.modal.alert('❌ Error: '+e.message); btn.disabled=false; btn.textContent='⚡ Rollover to '+nextTermLabel; });
          }
        });
      };
    }).catch(function(e){ el.innerHTML=s.errHtml(e); });
  },

  /* ═══ SETTINGS ═══ */
  loadSettings: function(el, tab){
    var s=this;
    el.innerHTML='<div class="tab-bar">'+
      [['school','School Info'],['classes','Classes'],['subjects','Subjects'],['fees','Fee Items'],['users','Users'],['permissions','Roles & Permissions'],['data','Data']].map(function(p){ return '<button class="btn tab-btn" data-tab="'+p[0]+'">'+p[1]+'</button>'; }).join('')+
      '</div><div id="settingsContent"></div>';
    var tabs=el.querySelectorAll('.tab-btn');
    var showTab=function(t){
      tabs.forEach(function(b){ b.classList.toggle('active',b.dataset.tab===t); });
      var c=document.getElementById('settingsContent'); c.innerHTML=s.spinner;
      ({school:function(){s._settingsSchoolTab(c);},classes:function(){s.loadClassesTab(c);},subjects:function(){s.loadSubjectsTab(c);},fees:function(){s.loadFeeItemsTab(c);},users:function(){s.loadUsersTab(c);},permissions:function(){s.loadPermissionsTab(c);},data:function(){s.loadDataTab(c);}})[t]();
    };
    tabs.forEach(function(b){ b.onclick=function(){ showTab(b.dataset.tab); }; });
    showTab(tab||'school');
  },
  _settingsSchoolTab: function(c){
    var s=this, E=function(v){ return s.escapeHtml(v); };
    s._cache.config=null;
    s.getConfig().then(function(cfg){
      var sw=cfg.scoreWeights||{};
      c.innerHTML='<div class="settings-section"><h3>🏫 School Identity</h3><div class="settings-row"><div><label>School Name</label><input id="sName" class="form-control" value="'+E(cfg.schoolName)+'"></div><div><label>Motto</label><input id="sMotto" class="form-control" value="'+E(cfg.schoolMotto)+'"></div></div><div style="margin-top:10px;"><label>Address</label><input id="sAddr" class="form-control" value="'+E(cfg.schoolAddress)+'"></div></div>'+
        '<div class="settings-section"><h3>📞 Contact</h3><div class="settings-row"><div><label>Email</label><input id="sEmail" class="form-control" value="'+E(cfg.schoolEmail)+'"></div><div><label>Phone</label><input id="sPhone" class="form-control" value="'+E(cfg.schoolPhone)+'"></div></div></div>'+
        '<div class="settings-section"><h3>📅 Academic</h3>'+
          '<p style="color:var(--gold);font-size:12px;margin-bottom:10px;">⚠️ Normally change term/year with Promotion → Term Rollover. Editing them here does not carry balances forward.</p>'+
          '<div class="settings-row"><div><label>Academic Year</label><input id="sAcadYear" class="form-control" value="'+E(cfg.currentAcademicYear)+'" placeholder="2025/2026"></div>'+
          '<div><label>Current Term</label><select id="sTerm" class="form-control">'+[1,2,3].map(function(t){ return '<option value="'+t+'"'+(cfg.currentTerm==t?' selected':'')+'>'+s.TERM_NAMES[t]+'</option>'; }).join('')+'</select></div></div>'+
          '<div class="settings-row" style="margin-top:10px;"><div><label>Term Days</label><input id="sTermDays" class="form-control" type="number" min="1" value="'+E(cfg.termDays||60)+'"></div>'+
          '<div><label>Next Term Begins</label><input id="sNextTermBegins" class="form-control" type="date" value="'+E(cfg.nextTermBegins)+'"></div></div>'+
          '<p style="color:var(--text-muted);font-size:12px;margin-top:4px;">"Next Term Begins" is shown at the top of every report card. Leave blank if not yet decided.</p>'+
          '<div class="settings-row" style="margin-top:10px;"><div><label>Promotion pass mark (Third Term average %)</label><input id="sPassMark" class="form-control" type="number" min="0" max="100" step="0.5" value="'+E(cfg.promotionPassMark||0)+'"></div>'+
          '<div><label>Admission fee — new students only (GH₵)</label><input id="sAdmFeeSet" class="form-control" type="number" min="0" step="0.01" value="'+E((parseFloat(cfg.admissionFee)||0).toFixed(2))+'"></div></div>'+
          '<p style="color:var(--text-muted);font-size:12px;margin-top:4px;">The admission fee is charged once, when a new admission is added (it can be changed or skipped on the form). Pass mark: 0 = every student is promoted. Otherwise students whose Third Term average is below this mark show "Repeated" on their report card. Teachers can override any student under Results.</p></div>'+
        '<div class="settings-section"><h3>📊 Scoring Weights</h3><div class="settings-row"><div><label>Class Score (%)</label><input id="sClassW" class="form-control" type="number" min="0" max="100" value="'+E(sw.classWeight)+'"></div><div><label>Exam Score (%)</label><input id="sExamW" class="form-control" type="number" min="0" max="100" value="'+E(sw.examWeight)+'"></div></div>'+
          '<p style="color:var(--text-muted);font-size:12px;margin-top:4px;">Must add up to 100. Changing weights only affects scores saved afterwards.</p></div>'+
        '<div class="settings-section"><h3>🖼️ School Logo</h3><div style="display:flex;gap:20px;flex-wrap:wrap;"><div style="flex:1;min-width:220px;"><label>📤 Upload Image</label><input type="file" id="crestFile" class="form-control" accept="image/*"><button class="btn" id="uploadCrestBtn" style="width:100%;">📤 Upload</button></div><div style="flex:1;min-width:220px;"><label>🔗 Or Paste URL (https://)</label><input id="crestUrl" class="form-control" placeholder="https://…"><button class="btn" id="saveCrestUrlBtn" style="width:100%;">🔗 Save URL</button></div></div>'+
          '<div style="margin-top:16px;padding:16px;background:var(--bg-primary);border-radius:10px;text-align:center;"><label>Current Logo</label><div id="crestPreview" style="display:flex;align-items:center;justify-content:center;min-height:80px;"></div></div></div>'+
        '<button class="btn" id="saveAllBtn" style="width:100%;margin-top:20px;padding:16px;font-size:16px;font-weight:700;">💾 Save All Settings</button><div id="settingsMsg" style="margin-top:10px;text-align:center;font-size:13px;padding:8px;border-radius:8px;display:none;"></div>';
      var setCrest=function(src){
        s._cache.crest=src;
        document.getElementById('crestPreview').innerHTML=src?'<img src="'+E(src)+'" style="max-width:150px;max-height:150px;border-radius:8px;border:2px solid var(--border);padding:4px;background:white;">':'<span style="font-size:48px;">🏫</span>';
        s.setCrest(src);
      };
      setCrest(s._cache.crest);
      document.getElementById('saveAllBtn').onclick=function(){
        var msg=document.getElementById('settingsMsg'), show=function(color,text){ msg.style.display='block'; msg.style.color=color; msg.textContent=text; };
        var cw=parseInt(document.getElementById('sClassW').value,10), ew=parseInt(document.getElementById('sExamW').value,10);
        var year=document.getElementById('sAcadYear').value.trim();
        if (isNaN(cw)||isNaN(ew)||cw<0||ew<0||cw+ew!==100) { show('var(--red)','❌ Class and exam weights must add up to 100.'); return; }
        if (!/^\d{4}\/\d{4}$/.test(year)) { show('var(--red)','❌ Academic year must look like 2025/2026.'); return; }
        if (!document.getElementById('sName').value.trim()) { show('var(--red)','❌ School name is required.'); return; }
        show('var(--gold)','Saving…');
        s.safeSubmit(this, function(){
          return Promise.all([
            s.call('updateSchoolConfig',{schoolName:document.getElementById('sName').value.trim(),schoolMotto:document.getElementById('sMotto').value,schoolAddress:document.getElementById('sAddr').value,
              schoolEmail:document.getElementById('sEmail').value.trim(),schoolPhone:document.getElementById('sPhone').value,currentTerm:parseInt(document.getElementById('sTerm').value,10),
              currentAcademicYear:year,termDays:parseInt(document.getElementById('sTermDays').value,10),nextTermBegins:document.getElementById('sNextTermBegins').value,promotionPassMark:document.getElementById('sPassMark').value,admissionFee:document.getElementById('sAdmFeeSet').value}),
            s.call('updateScoreWeights',{classWeight:cw,examWeight:ew})
          ]).then(function(r){
            var bad=r.filter(function(x){ return !x||!x.success; });
            if (bad.length) { show('var(--red)','❌ '+bad.map(function(x){ return (x&&x.message)||'Save failed'; }).join(' ')); return; }
            s._cache.config=null;
            document.getElementById('sidebarSchoolName').textContent=document.getElementById('sName').value;
            show('var(--green)','✅ Settings saved!'); setTimeout(function(){ msg.style.display='none'; },3000);
          });
        });
      };
      document.getElementById('uploadCrestBtn').onclick=function(){
        var f=document.getElementById('crestFile').files[0]; if(!f){ s.modal.alert('Select an image first.'); return; }
        s.safeSubmit(this, function(){
          return s.resizeImage(f,150).then(function(b64){
            return s.call('uploadSchoolCrest',{data:b64}).then(function(r){
              if (!r.success) { s.modal.alert('❌ '+r.message); return; }
              setCrest(b64); s.modal.alert('✅ Logo uploaded!');
            });
          });
        });
      };
      document.getElementById('saveCrestUrlBtn').onclick=function(){
        var url=document.getElementById('crestUrl').value.trim(); if(!/^https:\/\//i.test(url)){ s.modal.alert('Enter a link starting with https://'); return; }
        s.safeSubmit(this, function(){
          return s.call('uploadSchoolCrest',{data:url}).then(function(r){ if (!r.success) { s.modal.alert('❌ '+r.message); return; } setCrest(url); s.modal.alert('✅ Logo URL saved!'); });
        });
      };
    }).catch(function(e){ c.innerHTML=s.errHtml(e); });
  },
  // ── Classes: add, edit (name, category, code), reorder, delete ──
  loadClassesTab: function(c){
    var s=this, E=function(v){ return s.escapeHtml(v); }; s._cache.classes=null;
    s.getClasses().then(function(cl){
      var cats=Array.from(new Set(cl.map(function(x){ return x.category; }).filter(Boolean)));
      c.innerHTML='<p style="color:var(--text-muted);font-size:12px;margin-bottom:10px;">Order matters: promotion moves students to the <b>next class down this list</b>, and the last class graduates. Use ↑ ↓ to reorder. The category links a class to its subjects and lets you set fees for the whole category.</p>'+
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;"><input id="newCC" class="form-control" placeholder="Code (e.g. B1)" style="flex:1;min-width:110px;"><input id="newCN" class="form-control" placeholder="Name (e.g. Basic 1)" style="flex:2;min-width:150px;">'+
        '<input id="newCCat" class="form-control" list="catList" placeholder="Category (e.g. Lower Primary)" style="flex:2;min-width:150px;"><datalist id="catList">'+cats.map(function(x){ return '<option value="'+E(x)+'">'; }).join('')+'</datalist>'+
        '<button class="btn" id="addClassBtn" style="margin-top:5px;">Add</button></div><div id="classTable"></div>';
      var rows=cl.map(function(cx,i){
        var tr=document.createElement('tr');
        [cx.code,cx.name,cx.category].forEach(function(v){ tr.insertCell().textContent=v; });
        var td=tr.insertCell(); td.style.whiteSpace='nowrap';
        var mv=function(dir){ return function(){ s.call('moveClass',{code:cx.code,direction:dir}).then(function(r){ if(r.success) s.loadClassesTab(c); else s.modal.alert(r.message); }); }; };
        var up=s._btn('↑','btn-secondary',mv('up')); if (i===0) up.disabled=true; td.appendChild(up);
        var dn=s._btn('↓','btn-secondary',mv('down'),'margin-left:4px;'); if (i===cl.length-1) dn.disabled=true; td.appendChild(dn);
        td.appendChild(s._btn('Edit','',function(){
          s.modal.show('Edit class',
            '<label>Code</label><input id="ecCode" class="form-control" value="'+E(cx.code)+'">'+
            '<label>Name</label><input id="ecName" class="form-control" value="'+E(cx.name)+'">'+
            '<label>Category</label><input id="ecCat" class="form-control" list="catList" value="'+E(cx.category)+'">'+
            '<p style="font-size:12px;color:var(--text-muted);margin-top:6px;">Changing the code moves this class\'s students, fee items and fee overrides to the new code.</p><div id="ecErr" style="color:var(--red);font-size:13px;"></div>',
            [{text:'Cancel',cls:'btn-secondary'},{text:'Save',cb:function(){
              var err=document.getElementById('ecErr'); err.textContent='Saving…';
              s.call('updateClass',{code:cx.code,newCode:document.getElementById('ecCode').value.trim(),name:document.getElementById('ecName').value.trim(),category:document.getElementById('ecCat').value.trim()}).then(function(r){
                if (r.success) { s.modal.close(); s.invalidateStudents(); s._feeOvData=[]; s.modal.alert('✅ '+r.message).then(function(){ s.loadClassesTab(c); }); }
                else err.textContent='❌ '+r.message;
              }).catch(function(e){ err.textContent='❌ '+e.message; });
              return false;
            }}]);
        },'margin-left:4px;'));
        td.appendChild(s._btn('Del','btn-danger',function(){
          s.modal.confirm('Delete class <b>'+E(cx.code)+'</b>?').then(function(ok){
            if(!ok) return;
            s.call('deleteClass',{code:cx.code}).then(function(r){ if(r.success) s.loadClassesTab(c); else s.modal.alert('❌ '+r.message); });
          });
        },'margin-left:4px;'));
        return tr;
      });
      document.getElementById('classTable').appendChild(s._buildTable(['Code','Name','Category','Actions'],rows));
      document.getElementById('addClassBtn').onclick=function(){
        s.safeSubmit(this, function(){
          return s.call('addClass',{code:document.getElementById('newCC').value.trim(),name:document.getElementById('newCN').value.trim(),category:document.getElementById('newCCat').value.trim()}).then(function(r){
            if(r.success) s.loadClassesTab(c); else s.modal.alert('❌ '+r.message);
          });
        });
      };
    }).catch(function(e){ c.innerHTML=s.errHtml(e); });
  },
  // ── Subjects: add, edit (renames saved scores too), delete ──
  loadSubjectsTab: function(c){
    var s=this, E=function(v){ return s.escapeHtml(v); };
    Promise.all([s.call('getSubjects'), s.getClasses()]).then(function(res){
      var subs=res[0], cats=Array.from(new Set(res[1].map(function(x){ return x.category; }).concat(subs.map(function(x){ return x.category; })).filter(Boolean)));
      var catOpts=function(sel){ return cats.map(function(x){ return '<option'+(x===sel?' selected':'')+'>'+E(x)+'</option>'; }).join(''); };
      c.innerHTML='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;"><select id="newSubCat" class="form-control" style="flex:1;min-width:150px;">'+catOpts(cats[0])+'</select><input id="newSubName" class="form-control" placeholder="Subject name" style="flex:2;min-width:160px;"><button class="btn" id="addSubjectBtn" style="margin-top:5px;">Add</button></div>'+
        '<div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;"><label>Show</label><select id="subFilter" class="form-control" style="width:auto;"><option value="">All categories</option>'+catOpts('')+'</select></div><div id="subjectTable"></div>';
      var render=function(){
        var f=document.getElementById('subFilter').value, wrap=document.getElementById('subjectTable');
        var list=subs.filter(function(x){ return !f || x.category===f; });
        wrap.innerHTML='';
        wrap.appendChild(s._buildTable(['Category','Subject','Actions'], list.map(function(sb){
          var tr=document.createElement('tr');
          [sb.category,sb.subjectName].forEach(function(v){ tr.insertCell().textContent=v; });
          var td=tr.insertCell(); td.style.whiteSpace='nowrap';
          td.appendChild(s._btn('Edit','',function(){
            s.modal.show('Edit subject','<label>Category</label><select id="esCat" class="form-control">'+catOpts(sb.category)+'</select><label>Subject name</label><input id="esName" class="form-control" value="'+E(sb.subjectName)+'">'+
              '<p style="font-size:12px;color:var(--text-muted);margin-top:6px;">Renaming keeps scores already entered under the old name.</p><div id="esErr" style="color:var(--red);font-size:13px;"></div>',
              [{text:'Cancel',cls:'btn-secondary'},{text:'Save',cb:function(){
                var err=document.getElementById('esErr'); err.textContent='Saving…';
                s.call('updateSubject',{category:sb.category,name:sb.subjectName,newCategory:document.getElementById('esCat').value,newName:document.getElementById('esName').value.trim()}).then(function(r){
                  if (r.success) { s.modal.close(); s.modal.alert('✅ '+r.message).then(function(){ s.loadSubjectsTab(c); }); } else err.textContent='❌ '+r.message;
                }).catch(function(e){ err.textContent='❌ '+e.message; });
                return false;
              }}]);
          }));
          td.appendChild(s._btn('Del','btn-danger',function(){
            s.modal.confirm('Delete <b>'+E(sb.subjectName)+'</b> from '+E(sb.category)+'? Scores already entered stay saved but no longer show on report cards.').then(function(ok){
              if(!ok) return;
              s.call('deleteSubject',{category:sb.category,name:sb.subjectName}).then(function(r){ if(r.success) s.loadSubjectsTab(c); else s.modal.alert('❌ '+r.message); });
            });
          },'margin-left:4px;'));
          return tr;
        })));
      };
      document.getElementById('subFilter').onchange=render; render();
      document.getElementById('addSubjectBtn').onclick=function(){
        s.safeSubmit(this, function(){
          return s.call('addSubject',{category:document.getElementById('newSubCat').value,subjectName:document.getElementById('newSubName').value.trim()}).then(function(r){
            if(r.success) s.loadSubjectsTab(c); else s.modal.alert('❌ '+r.message);
          });
        });
      };
    }).catch(function(e){ c.innerHTML=s.errHtml(e); });
  },
  // ── Fee items: for one class, a whole category, or all classes ──
  loadFeeItemsTab: function(c){
    var s=this, E=function(v){ return s.escapeHtml(v); };
    Promise.all([s.call('getFeeItems'),s.getClasses(),s.getConfig()]).then(function(res){
      var fi=res[0]||[], cl=res[1], cfg=res[2]||{}, clMap={}, order={};
      cl.forEach(function(cx,i){ clMap[cx.code]=cx.name; order[cx.code]=i; });
      var cats=Array.from(new Set(cl.map(function(x){ return x.category; }).filter(Boolean)));
      var targetOpts='<optgroup label="Whole category">'+cats.map(function(cat){ var codes=cl.filter(function(x){ return x.category===cat; }).map(function(x){ return x.code; }); return '<option value="CAT:'+E(cat)+'">All '+E(cat)+' ('+E(codes.join(', '))+')</option>'; }).join('')+
        '<option value="ALL">All classes</option></optgroup><optgroup label="One class">'+cl.map(function(cx){ return '<option value="'+E(cx.code)+'">'+E(cx.name)+' ('+E(cx.code)+')</option>'; }).join('')+'</optgroup>';
      c.innerHTML='<p style="color:var(--text-muted);font-size:13px;margin-bottom:10px;">Fee items for <b>'+E(s.TERM_NAMES[cfg.currentTerm]||'')+' '+E(cfg.currentAcademicYear||'')+'</b>. Saving a component that already exists updates its amount — it is never charged twice. The admission fee is set separately (School Info) and charged once, to new students only.</p>'+
        '<div class="settings-section" style="padding:16px;"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">'+
          '<div style="flex:2;min-width:200px;"><label>Apply to</label><select id="feeTarget" class="form-control">'+targetOpts+'</select></div>'+
          '<div style="flex:2;min-width:160px;"><label>Fee component</label><input id="feeComp" class="form-control" list="compList" placeholder="e.g. Tuition"><datalist id="compList">'+Array.from(new Set(fi.map(function(f){ return f.component; }))).map(function(x){ return '<option value="'+E(x)+'">'; }).join('')+'</datalist></div>'+
          '<div style="flex:1;min-width:110px;"><label>Amount (GH₵)</label><input id="feeAmt" class="form-control" type="number" step="0.01" min="0" placeholder="0.00"></div>'+
          '<div><button class="btn" id="addFeeItemBtn" style="margin:5px 0;">💾 Save</button></div></div></div>'+
        '<div style="display:flex;gap:10px;align-items:center;margin:6px 0 8px;"><label>Show</label><select id="feeShow" class="form-control" style="width:auto;"><option value="">All classes</option>'+cl.map(function(cx){ return '<option value="'+E(cx.code)+'">'+E(cx.name)+'</option>'; }).join('')+'</select></div>'+
        '<div id="feeItemTable"></div>';
      var render=function(){
        var show=document.getElementById('feeShow').value, wrap=document.getElementById('feeItemTable');
        var list=fi.filter(function(f){ return !show || f.classCode===show; }).sort(function(a,b){ return (order[a.classCode]-order[b.classCode]) || a.component.localeCompare(b.component); });
        var totals={}; list.forEach(function(f){ totals[f.classCode]=(totals[f.classCode]||0)+f.amount; });
        wrap.innerHTML='';
        if (!list.length) { wrap.innerHTML='<p style="color:var(--text-muted);text-align:center;padding:20px;">No fee items yet.</p>'; return; }
        var last=null;
        wrap.appendChild(s._buildTable(['Class','Component','Amount','Actions'], list.map(function(f){
          var tr=document.createElement('tr');
          var first=f.classCode!==last; last=f.classCode;
          var c0=tr.insertCell(); c0.innerHTML=first?'<b>'+E(clMap[f.classCode]||f.classCode)+'</b><br><span style="font-size:11px;color:var(--text-muted);">Total '+E(s.money(totals[f.classCode]))+'</span>':'';
          tr.insertCell().textContent=f.component;
          var a=tr.insertCell(); a.textContent=s.money(f.amount); a.style.fontWeight='700';
          var td=tr.insertCell(); td.style.whiteSpace='nowrap';
          td.appendChild(s._btn('Edit','',function(){
            s.modal.show('Edit fee item — '+E(clMap[f.classCode]||f.classCode),
              '<label>Component</label><input id="efComp" class="form-control" value="'+E(f.component)+'"><label>Amount (GH₵)</label><input id="efAmt" class="form-control" type="number" step="0.01" min="0" value="'+E(f.amount)+'">'+
              '<p style="font-size:12px;color:var(--text-muted);margin-top:6px;">This changes '+E(f.classCode)+' only. To change a whole category, use <b>Apply to</b> above.</p><div id="efErr" style="color:var(--red);font-size:13px;"></div>',
              [{text:'Cancel',cls:'btn-secondary'},{text:'Save',cb:function(){
                var err=document.getElementById('efErr'), amt=parseFloat(document.getElementById('efAmt').value);
                if (isNaN(amt)||amt<0) { err.textContent='Enter a valid amount.'; return false; }
                err.textContent='Saving…';
                s.call('updateFeeItem',{classCode:f.classCode,component:f.component,newComponent:document.getElementById('efComp').value.trim(),amount:amt}).then(function(r){
                  if (r.success) { s.modal.close(); s._feeOvData=[]; s.loadFeeItemsTab(c); } else err.textContent='❌ '+r.message;
                }).catch(function(e){ err.textContent='❌ '+e.message; });
                return false;
              }}]);
          }));
          td.appendChild(s._btn('Del','btn-danger',function(){
            var cat=(cl.find(function(x){ return x.code===f.classCode; })||{}).category;
            var sameElsewhere=fi.filter(function(x){ return x.component===f.component && x.classCode!==f.classCode; }).length;
            s.modal.show('Delete fee item','Delete <b>'+E(f.component)+'</b>?',
              [{text:'Cancel',cls:'btn-secondary'},
               {text:'This class only ('+E(f.classCode)+')',cls:'btn-danger',cb:function(){ s.call('deleteFeeItem',{classCode:f.classCode,component:f.component,term:f.term,academicYear:f.academicYear}).then(function(r){ if(r.success){ s._feeOvData=[]; s.loadFeeItemsTab(c); } else s.modal.alert('❌ '+r.message); }); }}]
              .concat(cat&&sameElsewhere?[{text:'All '+E(cat),cls:'btn-danger',cb:function(){ s.call('deleteFeeItem',{target:'CAT:'+cat,component:f.component,term:f.term,academicYear:f.academicYear}).then(function(r){ if(r.success){ s._feeOvData=[]; s.modal.alert('✅ '+r.message).then(function(){ s.loadFeeItemsTab(c); }); } else s.modal.alert('❌ '+r.message); }); }}]:[]));
          },'margin-left:4px;'));
          return tr;
        })));
      };
      document.getElementById('feeShow').onchange=render; render();
      document.getElementById('addFeeItemBtn').onclick=function(){
        var target=document.getElementById('feeTarget').value, comp=document.getElementById('feeComp').value.trim(), amt=parseFloat(document.getElementById('feeAmt').value);
        if(!comp){ s.modal.alert('Please enter a fee component name.'); return; }
        if(isNaN(amt)||amt<0){ s.modal.alert('Please enter a valid amount.'); return; }
        s.safeSubmit(this, function(){
          return s.call('addFeeItem',{target:target,component:comp,amount:amt}).then(function(r){
            if(r.success){ s._feeOvData=[]; s.modal.alert('✅ '+r.message).then(function(){ s.loadFeeItemsTab(c); }); } else s.modal.alert('❌ '+r.message);
          });
        });
      };
    }).catch(function(e){ c.innerHTML=s.errHtml(e); });
  },
  // NEW: initial password field (every user used to get "changeme123"),
  // activate/deactivate, and no inline onclick strings.
  loadUsersTab: function(c){
    var s=this;
    Promise.all([s.call('getAllUsers'), s.call('getRoleNames')]).then(function(res){
      var users=res[0], roleNames=res[1]||['Admin'];
      s._roleNames=roleNames;
      var roleOpts=function(sel){ return roleNames.map(function(r){ return '<option value="'+s.escapeHtml(r)+'"'+(r===sel?' selected':'')+'>'+s.escapeHtml(r)+'</option>'; }).join(''); };
      c.innerHTML='<div id="userTable"></div>'+
        '<h4 style="margin-top:20px;">Add User</h4><div style="display:flex;gap:10px;flex-wrap:wrap;">'+
          '<input id="nuEmail" class="form-control" type="email" placeholder="Email" style="flex:2;min-width:180px;">'+
          '<input id="nuName" class="form-control" placeholder="Name" style="flex:2;min-width:150px;">'+
          '<input id="nuPass" class="form-control" type="password" placeholder="Initial password (min 6)" style="flex:2;min-width:150px;">'+
          '<select id="nuRole" class="form-control" style="flex:1;min-width:140px;">'+roleOpts(roleNames[1]||'Admin')+'</select>'+
          '<button class="btn" id="addUserBtn" style="margin-top:5px;">Add</button></div>'+
        '<p style="color:var(--text-muted);font-size:12px;margin-top:6px;">Share the initial password privately and ask the user to change it via 🔑 Change Password. Create or change roles under <b>Roles &amp; Permissions</b>.</p>';
      var me=(s.user&&s.user.email||'').toLowerCase();
      var rows=users.map(function(u){
        var tr=document.createElement('tr');
        tr.insertCell().textContent=u.name; tr.insertCell().textContent=u.email;
        tr.insertCell().appendChild(s.roleBadge(u.role));
        var st=tr.insertCell(); st.textContent=u.status||'active'; st.style.color=(u.status==='inactive')?'var(--red)':'var(--green)';
        var td=tr.insertCell();
        td.appendChild(s._btn('Edit','',function(){ s.editUser(u); }));
        if (u.email.toLowerCase()!==me) {
          var active=(u.status||'active')!=='inactive';
          td.appendChild(s._btn(active?'Deactivate':'Activate',active?'btn-gold':'',function(){
            s.call('setUserStatus',{email:u.email,status:active?'inactive':'active'}).then(function(r){ if(r.success) s.loadUsersTab(c); else s.modal.alert('❌ '+r.message); });
          },'margin-left:4px;'));
          if (u.role!=='Admin') td.appendChild(s._btn('Del','btn-danger',function(){
            s.modal.confirm('Delete user <b>'+s.escapeHtml(u.email)+'</b>?').then(function(ok){
              if(!ok) return;
              s.call('removeUser',{email:u.email}).then(function(r){ if(r.success) s.loadUsersTab(c); else s.modal.alert('❌ '+r.message); });
            });
          },'margin-left:4px;'));
        }
        return tr;
      });
      document.getElementById('userTable').appendChild(s._buildTable(['Name','Email','Role','Status','Actions'],rows));
      document.getElementById('addUserBtn').onclick=function(){
        var email=document.getElementById('nuEmail').value.trim(), name=document.getElementById('nuName').value.trim(), pass=document.getElementById('nuPass').value;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { s.modal.alert('Please enter a valid email.'); return; }
        if (!name) { s.modal.alert('Please enter a name.'); return; }
        if (pass.length<6) { s.modal.alert('Initial password must be at least 6 characters.'); return; }
        s.safeSubmit(this, function(){
          return s.call('addUser',{email:email,name:name,password:pass,role:document.getElementById('nuRole').value}).then(function(r){ if(r.success) s.loadUsersTab(c); else s.modal.alert('❌ '+r.message); });
        });
      };
    }).catch(function(e){ c.innerHTML=s.errHtml(e); });
  },
  editUser: function(u){
    var s=this;
    s.modal.show('Edit User',
      '<p style="margin-bottom:8px;">'+s.escapeHtml(u.email)+'</p>'+
      '<input id="euName" class="form-control" value="'+s.escapeHtml(u.name)+'">'+
      '<select id="euRole" class="form-control">'+(s._roleNames||['Admin']).concat((s._roleNames||[]).indexOf(u.role)<0&&u.role?[u.role]:[]).map(function(r){ return '<option value="'+s.escapeHtml(r)+'"'+(r===u.role?' selected':'')+'>'+s.escapeHtml(r)+'</option>'; }).join('')+'</select>'+
      '<input id="euPass" class="form-control" type="password" placeholder="New password (leave blank to keep)">'+
      '<div id="euErr" style="color:var(--red);font-size:13px;min-height:18px;"></div>',
      [{text:'Cancel',cls:'btn-secondary'},{text:'Save',cb:function(){
        var name=document.getElementById('euName').value.trim(), role=document.getElementById('euRole').value, pass=document.getElementById('euPass').value, err=document.getElementById('euErr');
        if (!name) { err.textContent='Name is required.'; return false; }
        if (pass && pass.length<6) { err.textContent='Password must be at least 6 characters.'; return false; }
        err.textContent='Saving…';
        s.call('updateUser',{email:u.email,name:name,role:role,password:pass||undefined}).then(function(r){
          if (r.success) { s.modal.close(); s.loadUsersTab(document.getElementById('settingsContent')); }
          else err.textContent='❌ '+r.message;
        }).catch(function(e){ err.textContent='❌ '+e.message; });
        return false;
      }}]);
  },

  /* ═══ PAYROLL ═══
     Staff register → monthly draft → Approve & pay (posts to Expenses).
     SSNIT and PAYE are optional (Payroll → Settings, and per person). */
  _payMonth: null,
  loadPayroll: function(el){
    var s=this;
    if (!s._payMonth) s._payMonth=s.todayYMD().slice(0,7);
    s.call('getPayrollSettings').then(function(cfg){
      s._payCfg=cfg;
      var tabs=[['run','📅 Monthly Payroll'],['staff','👥 Staff'],['year','📊 Year Summary']];
      if (s.can('payroll.pay')) tabs.push(['settings','⚙️ Settings']);
      el.innerHTML='<div class="tab-bar">'+tabs.map(function(t,i){ return '<button class="btn tab-btn'+(i===0?' active':'')+'" data-ptab="'+t[0]+'">'+t[1]+'</button>'; }).join('')+'</div><div id="payContent"></div>';
      var show=function(t){
        el.querySelectorAll('[data-ptab]').forEach(function(b){ b.classList.toggle('active', b.dataset.ptab===t); });
        var c=document.getElementById('payContent'); c.innerHTML=s.spinner;
        ({run:function(){ s._payRunTab(c); }, staff:function(){ s._payStaffTab(c); }, year:function(){ s._payYearTab(c); }, settings:function(){ s._paySettingsTab(c); }})[t]();
      };
      s._payShow=show;
      el.querySelectorAll('[data-ptab]').forEach(function(b){ b.onclick=function(){ show(b.dataset.ptab); }; });
      show('run');
    }).catch(function(e){ el.innerHTML=s.errHtml(e); });
  },
  _payMonthLabel: function(m){
    var p=String(m||'').split('-'), names=['January','February','March','April','May','June','July','August','September','October','November','December'];
    return (names[(+p[1])-1]||'')+' '+(p[0]||'');
  },
  _payStatusChip: function(st){
    var paid=st==='Paid';
    return '<span class="cls-badge" style="background:'+(paid?'var(--green-bg)':'var(--gold-bg)')+';color:'+(paid?'var(--green)':'var(--gold)')+';">'+(paid?'✓ Paid':'Draft')+'</span>';
  },
  _payRulesLine: function(cfg){
    var s=this; cfg=cfg||{};
    return 'SSNIT: <b>'+(cfg.ssnitEnabled?'on — '+cfg.ssnitEmployeeRate+'% staff + '+cfg.ssnitEmployerRate+'% school, on basic salary':'off')+'</b> · PAYE: <b>'+(cfg.payeEnabled?'on — '+s.escapeHtml(cfg.payeBandsLabel||'progressive bands'):'off')+'</b>';
  },

  /* ── Monthly payroll ── */
  _payRunTab: function(c){
    var s=this, E=function(v){ return s.escapeHtml(v===undefined||v===null?'':v); };
    c.innerHTML='<div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px;">'+
        '<div><label>Month</label><input id="payMonth" type="month" class="form-control" style="width:auto;" value="'+E(s._payMonth)+'"></div>'+
        '<div id="payRunBtns" style="display:flex;gap:8px;flex-wrap:wrap;padding-bottom:5px;"></div></div><div id="payRunBody">'+s.spinner+'</div>';
    document.getElementById('payMonth').onchange=function(){ if (this.value) { s._payMonth=this.value; load(); } };
    var load=function(){
      document.getElementById('payRunBody').innerHTML=s.spinner;
      s.call('getPayrollRun',{month:s._payMonth}).then(render).catch(function(e){ document.getElementById('payRunBody').innerHTML=s.errHtml(e); });
    };
    var render=function(d){
      var body=document.getElementById('payRunBody'), btns=document.getElementById('payRunBtns'); if (!body) return;
      btns.innerHTML=''; s._payData=d;
      if (!d.run) {
        body.innerHTML='<div style="background:var(--bg-secondary);border-radius:16px;padding:30px;text-align:center;">'+
          '<div style="font-size:34px;">🧾</div><h3 style="margin:8px 0;">No payroll for '+E(d.monthLabel)+' yet</h3>'+
          '<p style="color:var(--text-muted);margin-bottom:14px;">Prepare a draft from the staff list. Nothing is paid or posted to Expenses until you approve it.</p>'+
          '<button class="btn" id="payPrepBtn">Prepare '+E(d.monthLabel)+' payroll</button>'+
          '<p style="color:var(--text-muted);font-size:12px;margin-top:14px;">'+s._payRulesLine(s._payCfg)+'</p></div>';
        document.getElementById('payPrepBtn').onclick=function(){ prepare(this); };
        return;
      }
      var r=d.run, paid=r.status==='Paid', lines=d.lines||[];
      var card=function(label,val,col){ return '<div class="fee-stat"><div class="label">'+label+'</div><div class="value" style="color:'+col+'">'+val+'</div></div>'; };
      var html='<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px;"><h3 style="margin:0;">'+E(d.monthLabel)+'</h3>'+s._payStatusChip(r.status)+
          (paid?'<span style="color:var(--text-muted);font-size:13px;">Paid '+E(s.niceDate(r.paidDate))+' by '+E(r.payMethod)+(r.reference?' · ref '+E(r.reference):'')+(r.vouchers?' · '+E(r.vouchers):'')+'</span>':'')+'</div>'+
        '<div class="summary-grid">'+card('Staff',r.staffCount,'var(--text-primary)')+card('Gross pay',s.money(r.totalGross),'var(--blue)')+
          card('SSNIT (staff + school)',s.money(r.totalSSNITEmployee+r.totalSSNITEmployer),'var(--purple)')+card('PAYE',s.money(r.totalPAYE),'var(--orange)')+
          card('Net pay to staff',s.money(r.totalNet),'var(--green)')+card('Total cost to school',s.money(r.totalCost),'var(--red)')+'</div>'+
        '<p style="color:var(--text-muted);font-size:12px;margin:-4px 0 12px;">'+s._payRulesLine(r.settings||s._payCfg)+'</p>'+
        (r.notes&&!paid?'<div style="background:var(--gold-bg);color:var(--gold);padding:10px 14px;border-radius:10px;margin-bottom:12px;font-size:13px;">↩️ '+E(r.notes)+'</div>':'')+
        ((d.negative||[]).length?'<div style="background:var(--red-bg);color:var(--red);padding:10px 14px;border-radius:10px;margin-bottom:12px;font-size:13px;">⚠️ Net pay is below zero for '+E(d.negative.join(', '))+'. Reduce their deductions before paying.</div>':'')+
        (!paid?'<div style="background:var(--blue-bg);color:var(--blue);padding:10px 14px;border-radius:10px;margin-bottom:12px;font-size:13px;">Draft — figures follow the Staff list. Use <b>Adjust</b> for this month\'s bonus or salary advance. Approving posts <b>'+s.money(r.totalCost)+'</b> to Expenses.</div>':
          '<div style="background:var(--green-bg);color:var(--green);padding:10px 14px;border-radius:10px;margin-bottom:12px;font-size:13px;">Posted to Expenses: '+E((r.settings&&r.settings.categories?[r.settings.categories.salaries,r.settings.categories.ssnit,r.settings.categories.paye]:[]).join(', '))+'. These entries are locked there — use <b>Reverse</b> here to correct a mistake.</div>')+
        '<div id="payLines"></div>';
      body.innerHTML=html;
      var rows=lines.map(function(l){
        var tr=document.createElement('tr');
        var nm=tr.insertCell(); nm.innerHTML='<b>'+E(l.fullName)+'</b><br><span style="color:var(--text-muted);font-size:12px;">'+E(l.staffID)+(l.position?' · '+E(l.position):'')+'</span>'+(l.note?'<br><span style="color:var(--gold);font-size:12px;">'+E(l.note)+'</span>':'');
        [l.basic,l.allowancesTotal,l.bonus,l.gross].forEach(function(v){ tr.insertCell().textContent=s.money(v); });
        tr.insertCell().textContent=l.ssnitApplied?s.money(l.ssnitEmployee):'—';
        tr.insertCell().textContent=l.payeApplied?s.money(l.paye):'—';
        tr.insertCell().textContent=s.money(l.otherDeductions);
        var nt=tr.insertCell(); nt.innerHTML='<b style="color:'+(l.netPay<0?'var(--red)':'var(--green)')+'">'+E(s.money(l.netPay))+'</b>';
        var td=tr.insertCell(); td.style.whiteSpace='nowrap';
        if (!paid) {
          td.appendChild(s._btn('Adjust','',function(){ adjust(l); }));
          td.appendChild(s._btn('✕','btn-secondary',function(){
            s.modal.confirm('Leave <b>'+E(l.fullName)+'</b> out of the '+E(d.monthLabel)+' payroll?').then(function(ok){
              if (ok) s.call('updatePayrollLine',{month:r.month,staffID:l.staffID,exclude:true}).then(after).catch(fail);
            });
          },'margin-left:4px;'));
        }
        td.appendChild(s._btn('🧾','btn-gold',function(){ s._printPayslips(d,[l]); },'margin-left:4px;'));
        var bs=td.querySelectorAll('button'); if (bs.length===3) bs[1].title='Leave out of this month'; bs[bs.length-1].title='Print payslip';
        return tr;
      });
      var tot=document.createElement('tr'); tot.style.fontWeight='700';
      ['Total',s.money(lines.reduce(function(a,l){return a+l.basic;},0)),s.money(lines.reduce(function(a,l){return a+l.allowancesTotal;},0)),
       s.money(lines.reduce(function(a,l){return a+l.bonus;},0)),s.money(r.totalGross),s.money(r.totalSSNITEmployee),s.money(r.totalPAYE),
       s.money(r.totalOtherDeductions),s.money(r.totalNet),''].forEach(function(v){ tot.insertCell().textContent=v; });
      rows.push(tot);
      var wrap=document.getElementById('payLines');
      wrap.appendChild(s._buildTable(['Staff','Basic','Allowances','Bonus','Gross','SSNIT','PAYE','Other deductions','Net pay',''],rows));
      if ((d.available||[]).length && !paid) {
        var av=document.createElement('div'); av.style.cssText='margin-top:12px;font-size:13px;color:var(--text-muted);display:flex;gap:6px;flex-wrap:wrap;align-items:center;';
        av.innerHTML='<span>Not on this payroll:</span>';
        d.available.forEach(function(p){ av.appendChild(s._btn('+ '+p.fullName,'btn-secondary',function(){ s.call('updatePayrollLine',{month:r.month,staffID:p.staffID,include:true}).then(after).catch(fail); })); });
        wrap.appendChild(av);
      }
      // Buttons
      if (!paid) {
        btns.appendChild(s._btn('🔄 Recalculate','btn-secondary',function(){ prepare(this); }));
        if (s.can('payroll.pay')) btns.appendChild(s._btn('✅ Approve & pay','',function(){ pay(); }));
        btns.appendChild(s._btn('🗑️ Delete draft','btn-danger',function(){
          s.modal.confirm('Delete the '+E(d.monthLabel)+' draft? The staff list is not affected.').then(function(ok){
            if (ok) s.call('deletePayrollRun',{month:r.month}).then(function(x){ if (!x.success) s.modal.alert('❌ '+x.message); load(); }).catch(fail);
          });
        }));
      }
      btns.appendChild(s._btn('🖨️ Payslips','btn-gold',function(){ s._printPayslips(d,lines); }));
      btns.appendChild(s._btn('📄 Payroll register','btn-secondary',function(){ s._printPayRegister(d); }));
      if (paid && s.can('payroll.pay')) btns.appendChild(s._btn('↩️ Reverse','btn-danger',function(){ reverse(); }));
      if (!paid && !s.can('payroll.pay')) { var n=document.createElement('span'); n.style.cssText='color:var(--text-muted);font-size:12px;align-self:center;'; n.textContent='Approval needs the "Approve & pay payroll" permission.'; btns.appendChild(n); }
    };
    var fail=function(e){ s.modal.alert('Error: '+(e&&e.message?e.message:e)); };
    var after=function(x){ if (x && x.success===false && !x.run) { s.modal.alert('❌ '+x.message); return; } render(x); };
    var prepare=function(btn){
      s.safeSubmit(btn,function(){ return s.call('preparePayrollRun',{month:s._payMonth}).then(function(x){ if (!x.success) { s.modal.alert('❌ '+x.message); if (/staff first/i.test(x.message)) s._payShow('staff'); return; } render(x); }); });
    };
    var adjust=function(l){
      s.modal.show('Adjust — '+E(l.fullName),
        '<p style="font-size:13px;margin-bottom:10px;">Only for <b>'+E(s._payData.monthLabel)+'</b>. Regular allowances and deductions belong on the Staff tab.</p>'+
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;text-align:left;">'+
          '<div><label>Bonus / extra pay (GH₵)</label><input id="adjBonus" type="number" min="0" step="0.01" class="form-control" value="'+(l.bonus||'')+'"></div>'+
          '<div><label>Extra deduction (GH₵)</label><input id="adjDed" type="number" min="0" step="0.01" class="form-control" value="'+(l.extraDeduction||'')+'" placeholder="e.g. salary advance"></div>'+
          '<div style="grid-column:1/-1;"><label>Note (shows on the payslip)</label><input id="adjNote" class="form-control" maxlength="120" value="'+E(l.note)+'" placeholder="e.g. Advance recovered"></div></div>'+
        '<div id="adjErr" style="color:var(--red);font-size:13px;min-height:18px;"></div>',
        [{text:'Save',cb:function(){
          var b=parseFloat(document.getElementById('adjBonus').value)||0, x=parseFloat(document.getElementById('adjDed').value)||0;
          if (b<0||x<0) { document.getElementById('adjErr').textContent='Amounts must be zero or more.'; return false; }
          s.call('updatePayrollLine',{month:s._payData.run.month,staffID:l.staffID,bonus:b,extraDeduction:x,note:document.getElementById('adjNote').value.trim()}).then(after).catch(fail);
        }},{text:'Cancel',cls:'btn-secondary'}]);
    };
    var pay=function(){
      var d=s._payData, r=d.run, cats=(r.settings&&r.settings.categories)||{};
      if ((d.negative||[]).length) { s.modal.alert('Net pay is below zero for '+d.negative.join(', ')+'. Reduce their deductions first.'); return; }
      var row=function(a,b){ return '<tr><td style="padding:4px 0;">'+a+'</td><td style="text-align:right;font-weight:600;">'+b+'</td></tr>'; };
      s.modal.show('Approve & pay — '+E(d.monthLabel),
        '<div style="text-align:left;">'+
        '<p style="font-size:13px;margin-bottom:8px;">This marks <b>'+r.staffCount+' staff</b> as paid and posts to Expenses:</p>'+
        '<table style="width:100%;font-size:13px;margin-bottom:10px;">'+
          row(E(cats.salaries||'Salaries & Wages')+' <span style="color:var(--text-muted);">(net pay'+(r.totalOtherDeductions>0?' + other deductions':'')+')</span>',s.money(r.totalNet+r.totalOtherDeductions))+
          (r.totalSSNITEmployee+r.totalSSNITEmployer>0?row(E(cats.ssnit||'SSNIT & Pension')+' <span style="color:var(--text-muted);">(staff '+s.money(r.totalSSNITEmployee)+' + school '+s.money(r.totalSSNITEmployer)+')</span>',s.money(r.totalSSNITEmployee+r.totalSSNITEmployer)):'')+
          (r.totalPAYE>0?row(E(cats.paye||'PAYE Tax'),s.money(r.totalPAYE)):'')+
          '<tr><td style="padding-top:6px;border-top:1px solid var(--border);font-weight:700;">Total</td><td style="padding-top:6px;border-top:1px solid var(--border);text-align:right;font-weight:800;color:var(--red);">'+s.money(r.totalCost)+'</td></tr></table>'+
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">'+
          '<div><label>Payment date</label><input id="ppDate" type="date" class="form-control" max="'+s.todayYMD()+'" value="'+s.todayYMD()+'"></div>'+
          '<div><label>Paid by</label><select id="ppMethod" class="form-control">'+['Bank','Mobile Money','Cash','Cheque'].map(function(m){ return '<option>'+m+'</option>'; }).join('')+'</select></div>'+
          '<div style="grid-column:1/-1;"><label>Reference (optional)</label><input id="ppRef" class="form-control" maxlength="60" placeholder="Bank batch / cheque no."></div></div>'+
        '<div id="ppErr" style="color:var(--red);font-size:13px;min-height:18px;"></div></div>',
        [{text:'✅ Approve & pay',cb:function(){
          var btn=document.getElementById('mb0');
          s.safeSubmit(btn,function(){
            return s.call('payPayrollRun',{month:r.month,paymentDate:document.getElementById('ppDate').value,payMethod:document.getElementById('ppMethod').value,
                reference:document.getElementById('ppRef').value.trim(),expectedNet:r.totalNet,expectedCount:r.staffCount}).then(function(x){
              s.invalidateExpenses();
              if (x.changed) { s.modal.close(); render(x); s.modal.alert('⚠️ '+x.message); return; }
              if (!x.success) { document.getElementById('ppErr').textContent='❌ '+x.message; return; }
              s.modal.close(); render(x); s.modal.alert((x.duplicate?'⚠️ ':'✅ ')+x.message);
            });
          });
          return false;
        }},{text:'Cancel',cls:'btn-secondary'}]);
    };
    var reverse=function(){
      var d=s._payData;
      s.modal.show('Reverse '+E(d.monthLabel)+' payroll',
        '<p style="font-size:13px;text-align:left;">This removes the payroll\'s entries from Expenses ('+s.money(d.run.totalCost)+') and reopens the month as a draft so it can be corrected and paid again. Money already sent to staff is not affected.</p>'+
        '<input id="revReason" class="form-control" maxlength="150" placeholder="Reason (required)"><div id="revErr" style="color:var(--red);font-size:13px;min-height:18px;"></div>',
        [{text:'↩️ Reverse',cls:'btn-danger',cb:function(){
          var why=document.getElementById('revReason').value.trim();
          if (!why) { document.getElementById('revErr').textContent='Please give a reason.'; return false; }
          s.call('reversePayrollRun',{month:d.run.month,reason:why}).then(function(x){ s.invalidateExpenses(); if (!x.success) { s.modal.alert('❌ '+x.message); return; } render(x); s.modal.alert('✅ '+x.message); }).catch(fail);
        }},{text:'Cancel',cls:'btn-secondary'}]);
    };
    load();
  },

  /* ── Staff register ── */
  _payStaffTab: function(c){
    var s=this, E=function(v){ return s.escapeHtml(v===undefined||v===null?'':v); };
    s.call('getPayrollStaff').then(function(list){
      s._payStaff=list;
      var active=list.filter(function(x){ return x.status==='Active'; });
      var monthly=active.reduce(function(a,x){ return a+x.basicSalary+x.allowances.reduce(function(b,y){ return b+y.amount; },0); },0);
      c.innerHTML='<div class="summary-grid">'+
          '<div class="fee-stat"><div class="label">Active staff</div><div class="value">'+active.length+'</div></div>'+
          '<div class="fee-stat"><div class="label">Monthly basic + allowances</div><div class="value" style="color:var(--blue)">'+s.money(monthly)+'</div></div></div>'+
        '<div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap;"><button class="btn" id="payAddStaff">+ Add staff</button>'+
        '<input id="payStaffSearch" class="form-control" placeholder="Search name / ID / position / qualification…" style="flex:1;min-width:180px;margin:0;"></div><div id="payStaffTbl"></div>';
      document.getElementById('payAddStaff').onclick=function(){ s._payStaffForm(null); };
      var draw=function(){
        var q=(document.getElementById('payStaffSearch').value||'').toLowerCase();
        var rows=list.filter(function(x){ return !q || (x.fullName+' '+x.staffID+' '+x.position+' '+(x.qualification||'')).toLowerCase().indexOf(q)>=0; }).map(function(x){
          var tr=document.createElement('tr'); if (x.status!=='Active') tr.style.opacity='.55';
          var nm=tr.insertCell(); nm.innerHTML='<b>'+E(x.fullName)+'</b><br><span style="color:var(--text-muted);font-size:12px;">'+E(x.staffID)+(x.phone?' · '+E(x.phone):'')+'</span>';
          tr.insertCell().textContent=x.position||'—';
          tr.insertCell().textContent=x.qualification||'—';
          tr.insertCell().textContent=s.money(x.basicSalary);
          tr.insertCell().textContent=x.allowances.length?s.money(x.allowances.reduce(function(a,y){ return a+y.amount; },0)):'—';
          tr.insertCell().textContent=x.ssnitApplies?'Yes':'No';
          tr.insertCell().textContent=x.payeApplies?'Yes':'No';
          tr.insertCell().innerHTML=x.status==='Active'?'<span style="color:var(--green)">Active</span>':'<span style="color:var(--text-muted)">Inactive</span>';
          var td=tr.insertCell(); td.style.whiteSpace='nowrap';
          td.appendChild(s._btn('Edit','',function(){ s._payStaffForm(x); }));
          td.appendChild(s._btn(x.status==='Active'?'Deactivate':'Activate','btn-secondary',function(){
            s.call('savePayrollStaff',{staff:Object.assign({},x,{status:x.status==='Active'?'Inactive':'Active'})}).then(function(r){ if (!r.success) s.modal.alert('❌ '+r.message); s._payShow('staff'); });
          },'margin-left:4px;'));
          td.appendChild(s._btn('Del','btn-danger',function(){
            s.modal.confirm('Delete <b>'+E(x.fullName)+'</b> from the staff list?').then(function(ok){
              if (ok) s.call('deletePayrollStaff',{staffID:x.staffID}).then(function(r){ if (!r.success) s.modal.alert('❌ '+r.message); else s._payShow('staff'); });
            });
          },'margin-left:4px;'));
          return tr;
        });
        var w=document.getElementById('payStaffTbl'); w.innerHTML='';
        if (!list.length) { w.innerHTML='<p style="color:var(--text-muted);text-align:center;padding:30px;">No staff yet. Click <b>+ Add staff</b>.</p>'; return; }
        w.appendChild(s._buildTable(['Name','Position','Qualification','Basic','Allowances','SSNIT','PAYE','Status',''],rows));
      };
      document.getElementById('payStaffSearch').oninput=draw;
      draw();
    }).catch(function(e){ c.innerHTML=s.errHtml(e); });
  },
  // Same maths as the server (PayrollModule.gs payrollComputeLine_) for the live estimate.
  _payCalc: function(st, cfg){
    var r2=function(v){ return Math.round((Number(v)||0)*100)/100; };
    var basic=r2(st.basicSalary), allow=r2((st.allowances||[]).reduce(function(a,x){ return a+(x.amount>0?x.amount:0); },0)), gross=r2(basic+allow);
    var sOn=cfg.ssnitEnabled&&st.ssnitApplies, pOn=cfg.payeEnabled&&st.payeApplies, cap=parseFloat(cfg.ssnitMaxInsurable)||0;
    var base=sOn?(cap>0?Math.min(basic,cap):basic):0, se=sOn?r2(base*cfg.ssnitEmployeeRate/100):0, sr=sOn?r2(base*cfg.ssnitEmployerRate/100):0;
    var taxable=r2(Math.max(0,gross-se)), left=taxable, tax=0, b=cfg.payeBands||[];
    if (pOn) for (var i=0;i<b.length&&left>0;i++){ var w=(b[i].width===null||b[i].width===undefined||i===b.length-1)?left:Math.min(left,b[i].width); tax+=w*(parseFloat(b[i].rate)||0)/100; left=r2(left-w); }
    var paye=pOn?r2(tax):0, ded=r2((st.deductions||[]).reduce(function(a,x){ return a+(x.amount>0?x.amount:0); },0));
    return { gross:gross, ssnitEmployee:se, ssnitEmployer:sr, taxable:taxable, paye:paye, other:ded, net:r2(gross-se-paye-ded) };
  },
  _payStaffForm: function(x){
    var s=this, E=function(v){ return s.escapeHtml(v===undefined||v===null?'':v); }, cfg=s._payCfg||{};
    x=x||{ status:'Active', ssnitApplies:true, payeApplies:true, payMethod:'Bank', allowances:[], deductions:[] };
    var allow=(x.allowances||[]).map(function(a){ return {name:a.name,amount:a.amount}; }), ded=(x.deductions||[]).map(function(a){ return {name:a.name,amount:a.amount}; });
    var idem=x.staffID?null:s.newIdemKey();
    var f=function(id,label,val,extra){ return '<div><label>'+label+'</label><input id="'+id+'" class="form-control" value="'+E(val)+'" '+(extra||'')+'></div>'; };
    s.modal.show(x.staffID?'Edit staff — '+E(x.staffID):'Add staff',
      '<div style="text-align:left;">'+
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;">'+
        f('sfName','Full name *',x.fullName,'maxlength="80"')+f('sfPos','Position',x.position,'maxlength="60" placeholder="e.g. Class teacher"')+
        f('sfQual','Qualification',x.qualification,'maxlength="80" list="sfQualList" placeholder="e.g. B.Ed. Basic Education"')+
        '<datalist id="sfQualList">'+['BECE','WASSCE / SSSCE',"Certificate 'A'",'Diploma in Basic Education (DBE)','Diploma (other)','HND','B.Ed.','B.A.','B.Sc.','PGDE','M.Ed.','M.A.','M.Sc.','MPhil','PhD'].map(function(q){ return '<option value="'+E(q)+'">'; }).join('')+'</datalist>'+
        f('sfPhone','Phone',x.phone,'inputmode="tel" maxlength="20"')+f('sfEmail','Email',x.email,'type="email" maxlength="80"')+
        '<div><label>Paid by</label><select id="sfMethod" class="form-control">'+['Bank','Mobile Money','Cash','Cheque'].map(function(m){ return '<option'+(x.payMethod===m?' selected':'')+'>'+m+'</option>'; }).join('')+'</select></div>'+
        f('sfAcct','Bank account / MoMo number',x.accountDetails,'maxlength="120" placeholder="e.g. GCB 1234567890"')+
        f('sfSsnitNo','SSNIT number',x.ssnitNumber,'maxlength="30"')+f('sfTin','Ghana Card / TIN',x.ghanaCardTIN,'maxlength="30"')+
        f('sfStart','Start date',x.startDate,'type="date"')+f('sfBasic','Basic salary (GH₵ / month) *',x.basicSalary===undefined?'':x.basicSalary,'type="number" min="0" step="0.01"')+
      '</div>'+
      '<div style="display:flex;gap:18px;flex-wrap:wrap;margin:12px 0 4px;">'+
        '<label style="display:flex;gap:8px;align-items:center;cursor:pointer;"><input type="checkbox" id="sfSsnit"'+(x.ssnitApplies?' checked':'')+' style="width:18px;height:18px;"> Deduct SSNIT</label>'+
        '<label style="display:flex;gap:8px;align-items:center;cursor:pointer;"><input type="checkbox" id="sfPaye"'+(x.payeApplies?' checked':'')+' style="width:18px;height:18px;"> Deduct PAYE</label></div>'+
      ((!cfg.ssnitEnabled||!cfg.payeEnabled)?'<p style="font-size:12px;color:var(--gold);">'+(!cfg.ssnitEnabled?'SSNIT':'')+(!cfg.ssnitEnabled&&!cfg.payeEnabled?' and ':'')+(!cfg.payeEnabled?'PAYE':'')+' '+((!cfg.ssnitEnabled&&!cfg.payeEnabled)?'are':'is')+' switched off for the whole school (Payroll → Settings).</p>':'')+
      '<h4 style="margin:12px 0 4px;">Monthly allowances</h4><div id="sfAllow"></div><button class="btn btn-sm btn-secondary" id="sfAddAllow" type="button">+ Allowance</button>'+
      '<h4 style="margin:12px 0 4px;">Monthly deductions <span style="font-weight:400;color:var(--text-muted);font-size:12px;">(welfare, loan repayment… — not SSNIT/PAYE)</span></h4><div id="sfDed"></div><button class="btn btn-sm btn-secondary" id="sfAddDed" type="button">+ Deduction</button>'+
      f('sfNotes','Notes',x.notes,'maxlength="200"')+
      '<div id="sfCalc" style="margin-top:10px;background:var(--bg-secondary);border-radius:12px;padding:10px 12px;font-size:13px;"></div>'+
      '<div style="margin-top:8px;"><label style="display:flex;gap:8px;align-items:center;cursor:pointer;"><input type="checkbox" id="sfActive"'+(x.status!=='Inactive'?' checked':'')+' style="width:18px;height:18px;"> Active (included in payroll)</label></div>'+
      '<div id="sfErr" style="color:var(--red);font-size:13px;min-height:18px;margin-top:6px;"></div></div>',
      [{text:'💾 Save',cb:function(){ save(false); return false; }},{text:'Cancel',cls:'btn-secondary'}]);
    var items=function(boxId,arr,ph){
      var box=document.getElementById(boxId); box.innerHTML='';
      arr.forEach(function(it,i){
        var row=document.createElement('div'); row.style.cssText='display:flex;gap:6px;align-items:center;';
        row.innerHTML='<input class="form-control" placeholder="'+ph+'" maxlength="60" value="'+E(it.name)+'" style="flex:2;"><input class="form-control" type="number" min="0" step="0.01" placeholder="GH₵" value="'+(it.amount===''||it.amount===undefined?'':it.amount)+'" style="flex:1;">';
        var ins=row.querySelectorAll('input');
        ins[0].oninput=function(){ it.name=this.value; };
        ins[1].oninput=function(){ it.amount=this.value===''?'':parseFloat(this.value); calc(); };
        row.appendChild(s._btn('✕','btn-danger',function(){ arr.splice(i,1); items(boxId,arr,ph); calc(); }));
        box.appendChild(row);
      });
    };
    var read=function(){
      return { staffID:x.staffID||'', fullName:document.getElementById('sfName').value.trim(), position:document.getElementById('sfPos').value.trim(),
        qualification:document.getElementById('sfQual').value.trim(),
        phone:document.getElementById('sfPhone').value.trim(), email:document.getElementById('sfEmail').value.trim(), payMethod:document.getElementById('sfMethod').value,
        accountDetails:document.getElementById('sfAcct').value.trim(), ssnitNumber:document.getElementById('sfSsnitNo').value.trim(), ghanaCardTIN:document.getElementById('sfTin').value.trim(),
        startDate:document.getElementById('sfStart').value, basicSalary:document.getElementById('sfBasic').value,
        ssnitApplies:document.getElementById('sfSsnit').checked, payeApplies:document.getElementById('sfPaye').checked,
        status:document.getElementById('sfActive').checked?'Active':'Inactive', notes:document.getElementById('sfNotes').value.trim(),
        allowances:allow.filter(function(a){ return String(a.name||'').trim()||a.amount; }), deductions:ded.filter(function(a){ return String(a.name||'').trim()||a.amount; }) };
    };
    var calc=function(){
      var box=document.getElementById('sfCalc'); if (!box) return;
      var d=read(); d.basicSalary=parseFloat(d.basicSalary)||0;
      var c=s._payCalc(d,cfg);
      box.innerHTML='<b>Monthly estimate:</b> gross '+s.money(c.gross)+' − SSNIT '+s.money(c.ssnitEmployee)+' − PAYE '+s.money(c.paye)+(c.other?' − other '+s.money(c.other):'')+
        ' = <b style="color:'+(c.net<0?'var(--red)':'var(--green)')+'">net '+s.money(c.net)+'</b>'+(c.ssnitEmployer?'<br><span style="color:var(--text-muted);">School also pays SSNIT '+s.money(c.ssnitEmployer)+' (not deducted from salary).</span>':'');
    };
    items('sfAllow',allow,'e.g. Transport'); items('sfDed',ded,'e.g. Welfare');
    document.getElementById('sfAddAllow').onclick=function(){ allow.push({name:'',amount:''}); items('sfAllow',allow,'e.g. Transport'); };
    document.getElementById('sfAddDed').onclick=function(){ ded.push({name:'',amount:''}); items('sfDed',ded,'e.g. Welfare'); };
    ['sfBasic','sfSsnit','sfPaye'].forEach(function(id){ var el=document.getElementById(id); el.oninput=calc; el.onchange=calc; });
    calc();
    var save=function(confirmDup){
      var d=read(), err=document.getElementById('sfErr');
      if (!d.fullName) { err.textContent='Please enter the full name.'; return; }
      if (d.basicSalary===''||!(parseFloat(d.basicSalary)>=0)) { err.textContent='Please enter the basic salary (0 or more).'; return; }
      var bad=d.allowances.concat(d.deductions).find(function(a){ return !String(a.name||'').trim()||!(a.amount>=0)||a.amount===''; });
      if (bad) { err.textContent='Each allowance/deduction needs a name and an amount.'; return; }
      d.basicSalary=parseFloat(d.basicSalary);
      var btn=document.getElementById('mb0');
      s.safeSubmit(btn,function(){
        return s.call('savePayrollStaff',{staff:d,idempotencyKey:idem,confirmDuplicate:!!confirmDup}).then(function(r){
          if (r.possibleDuplicate) {
            err.innerHTML='⚠️ '+E(r.message)+' <button class="btn btn-sm btn-gold" id="sfDupOk" type="button">Add anyway</button>';
            document.getElementById('sfDupOk').onclick=function(){ save(true); };
            return;
          }
          if (!r.success) { err.textContent='❌ '+r.message; return; }
          s.modal.close(); s._payShow('staff');
        });
      });
    };
  },

  /* ── Year summary (for SSNIT / GRA returns) ── */
  _payYearTab: function(c){
    var s=this, E=function(v){ return s.escapeHtml(v===undefined||v===null?'':v); }, y=+s.todayYMD().slice(0,4), opts='';
    for (var i=y;i>=y-5;i--) opts+='<option>'+i+'</option>';
    c.innerHTML='<div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px;"><div><label>Year</label><select id="pyYear" class="form-control" style="width:auto;">'+opts+'</select></div>'+
      '<button class="btn btn-secondary" id="pyPrint" style="margin-bottom:5px;">🖨️ Print</button></div><div id="pyBody"></div>';
    var data=null;
    var load=function(){
      var b=document.getElementById('pyBody'); b.innerHTML=s.spinner;
      s.call('getPayrollYearSummary',{year:document.getElementById('pyYear').value}).then(function(d){
        data=d;
        if (!d.rows.length) { b.innerHTML='<p style="color:var(--text-muted);text-align:center;padding:30px;">No paid payrolls in '+E(d.year)+'.</p>'; return; }
        b.innerHTML='<p style="color:var(--text-muted);font-size:13px;margin-bottom:10px;">Paid months: '+E(d.monthsPaid.map(s._payMonthLabel).join(', '))+'</p>'+s._payYearTable(d);
      }).catch(function(e){ b.innerHTML=s.errHtml(e); });
    };
    document.getElementById('pyYear').onchange=load;
    document.getElementById('pyPrint').onclick=function(){
      if (!data||!data.rows.length) return;
      s.getConfig().then(function(cf){
        document.getElementById('printContent').innerHTML='<div style="font-family:Arial,sans-serif;"><h2 style="margin:0;color:#0b5d3b;">'+E(cf.schoolName)+'</h2><h3 style="margin:4px 0 12px;">Payroll summary — '+E(data.year)+'</h3>'+
          '<p style="font-size:12px;">Paid months: '+E(data.monthsPaid.map(s._payMonthLabel).join(', '))+'</p>'+s._payYearTable(data,true)+'</div>';
        s.printContent('@page { size: A4 landscape; margin: 12mm; }');
      });
    };
    load();
  },
  _payYearTable: function(d, print){
    var s=this, E=function(v){ return s.escapeHtml(v===undefined||v===null?'':v); };
    var st=print?' style="border:1px solid #ccc;padding:4px 6px;font-size:11px;"':'';
    var head=['Staff','SSNIT no.','Ghana Card / TIN','Months','Gross','SSNIT (staff)','SSNIT (school)','PAYE','Other ded.','Net pay'];
    return '<div class="table-wrap"><table class="data-table"'+(print?' style="border-collapse:collapse;width:100%;"':'')+'><thead><tr>'+head.map(function(h){ return '<th'+st+'>'+h+'</th>'; }).join('')+'</tr></thead><tbody>'+
      d.rows.map(function(r){ return '<tr>'+[E(r.fullName)+' <span style="color:#888;font-size:11px;">'+E(r.staffID)+'</span>',E(r.ssnitNumber||'—'),E(r.ghanaCardTIN||'—'),r.months,s.money(r.gross),s.money(r.ssnitEmployee),s.money(r.ssnitEmployer),s.money(r.paye),s.money(r.otherDeductions),s.money(r.netPay)].map(function(v){ return '<td'+st+'>'+v+'</td>'; }).join('')+'</tr>'; }).join('')+
      '<tr style="font-weight:700;">'+['Total','','','',s.money(d.totals.gross),s.money(d.totals.ssnitEmployee),s.money(d.totals.ssnitEmployer),s.money(d.totals.paye),s.money(d.totals.otherDeductions),s.money(d.totals.netPay)].map(function(v){ return '<td'+st+'>'+v+'</td>'; }).join('')+'</tr></tbody></table></div>';
  },

  /* ── Settings: SSNIT / PAYE optional, editable rates and bands ── */
  _paySettingsTab: function(c){
    var s=this, E=function(v){ return s.escapeHtml(v===undefined||v===null?'':v); };
    s.call('getPayrollSettings').then(function(cfg){
      s._payCfg=cfg;
      var bands=(cfg.payeBands||[]).map(function(b){ return {width:b.width,rate:b.rate}; });
      var chk=function(id,on,label,hint){ return '<label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;background:var(--bg-secondary);border-radius:12px;padding:12px 14px;margin-bottom:8px;"><input type="checkbox" id="'+id+'"'+(on?' checked':'')+' style="width:20px;height:20px;flex-shrink:0;"><span><b>'+label+'</b><br><span style="color:var(--text-muted);font-size:12px;">'+hint+'</span></span></label>'; };
      var num=function(id,label,val,step){ return '<div><label>'+label+'</label><input id="'+id+'" type="number" min="0" step="'+(step||'0.01')+'" class="form-control" value="'+E(val)+'"></div>'; };
      c.innerHTML='<div style="max-width:760px;">'+
        chk('psSsnit',cfg.ssnitEnabled,'Deduct SSNIT','Staff contribution is taken from salary; the school\'s share is added to the cost. Can also be switched off per staff member.')+
        '<div id="psSsnitBox" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:0 0 14px;">'+
          num('psEmp','Staff rate (%)',cfg.ssnitEmployeeRate)+num('psEmr','School rate (%)',cfg.ssnitEmployerRate)+num('psCap','Max insurable salary (GH₵, 0 = none)',cfg.ssnitMaxInsurable)+'</div>'+
        chk('psPaye',cfg.payeEnabled,'Deduct PAYE (income tax)','Worked on gross pay minus staff SSNIT, using the bands below. Can also be switched off per staff member.')+
        '<div id="psPayeBox"><div><label>Name of this tax table</label><input id="psLabel" class="form-control" maxlength="80" value="'+E(cfg.payeBandsLabel)+'"></div>'+
          '<h4 style="margin:10px 0 4px;">Monthly PAYE bands</h4><div id="psBands"></div>'+
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;"><button class="btn btn-sm btn-secondary" id="psAddBand" type="button">+ Band</button></div>'+
          '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;"><span>Test: tax on</span><input id="psTest" type="number" min="0" step="0.01" class="form-control" style="width:140px;margin:0;" value="3000"><span id="psTestOut" style="font-weight:700;"></span></div></div>'+
        '<h4 style="margin:18px 0 4px;">Expense categories used when payroll is paid</h4>'+
        '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">'+
          '<div><label>Salaries</label><input id="psCatS" class="form-control" maxlength="40" value="'+E(cfg.categories.salaries)+'"></div>'+
          '<div><label>SSNIT</label><input id="psCatN" class="form-control" maxlength="40" value="'+E(cfg.categories.ssnit)+'"></div>'+
          '<div><label>PAYE</label><input id="psCatP" class="form-control" maxlength="40" value="'+E(cfg.categories.paye)+'"></div></div>'+
        '<div id="psErr" style="color:var(--red);font-size:13px;min-height:18px;margin-top:8px;"></div>'+
        '<div style="display:flex;gap:10px;flex-wrap:wrap;"><button class="btn" id="psSave">💾 Save settings</button><button class="btn btn-secondary" id="psReset">Reset to Ghana 2026 rates</button></div>'+
        '<p style="color:var(--text-muted);font-size:12px;margin-top:14px;">Defaults: SSNIT 5.5% staff + 13% school on basic salary (max insurable GH₵69,000/month for 2026); PAYE bands of the Income Tax (Amendment) Act, 2026 (Act 1178), in force from 1 September 2026. Changes apply to drafts and future payrolls — paid months keep the rates they were paid with. Confirm current rates with GRA and SSNIT.</p></div>';
      var drawBands=function(){
        var box=document.getElementById('psBands'); box.innerHTML='';
        var from=0;
        bands.forEach(function(b,i){
          var last=i===bands.length-1, row=document.createElement('div');
          row.style.cssText='display:flex;gap:6px;align-items:center;margin-bottom:4px;flex-wrap:wrap;';
          row.innerHTML=last
            ?'<span style="min-width:268px;font-size:13px;">Above GH₵ '+from.toLocaleString('en-GH',{maximumFractionDigits:2})+'</span>'
            :'<span style="font-size:13px;min-width:60px;">'+(i===0?'First':'Next')+'</span><input class="form-control" type="number" min="0.01" step="0.01" value="'+(b.width||'')+'" style="width:160px;margin:0;"><span style="font-size:13px;">GH₵ at</span>';
          var r=document.createElement('input'); r.className='form-control'; r.type='number'; r.min='0'; r.max='100'; r.step='0.01'; r.value=b.rate; r.style.cssText='width:90px;margin:0;';
          row.appendChild(r); var pct=document.createElement('span'); pct.textContent='%'; pct.style.fontSize='13px'; row.appendChild(pct);
          if (!last) row.querySelector('input').oninput=function(){ b.width=parseFloat(this.value)||0; test(); };
          r.oninput=function(){ b.rate=parseFloat(this.value)||0; test(); };
          if (bands.length>1) row.appendChild(s._btn('✕','btn-danger',function(){ bands.splice(i,1); drawBands(); test(); }));
          box.appendChild(row);
          from+=last?0:(parseFloat(b.width)||0);
        });
      };
      var test=function(){
        var v=parseFloat(document.getElementById('psTest').value)||0;
        var c2=s._payCalc({basicSalary:v,ssnitApplies:false,payeApplies:true,allowances:[],deductions:[]},{ssnitEnabled:false,payeEnabled:true,payeBands:bands});
        document.getElementById('psTestOut').textContent='= PAYE '+s.money(c2.paye)+' a month';
      };
      var toggle=function(){
        document.getElementById('psSsnitBox').style.opacity=document.getElementById('psSsnit').checked?'1':'.45';
        document.getElementById('psPayeBox').style.opacity=document.getElementById('psPaye').checked?'1':'.45';
      };
      document.getElementById('psSsnit').onchange=toggle; document.getElementById('psPaye').onchange=toggle; toggle();
      document.getElementById('psAddBand').onclick=function(){ var last=bands.pop()||{rate:0}; bands.push({width:1000,rate:last.rate}); bands.push(last); drawBands(); test(); };
      document.getElementById('psTest').oninput=test;
      drawBands(); test();
      document.getElementById('psSave').onclick=function(){
        var payload={ ssnitEnabled:document.getElementById('psSsnit').checked, payeEnabled:document.getElementById('psPaye').checked,
          ssnitEmployeeRate:document.getElementById('psEmp').value, ssnitEmployerRate:document.getElementById('psEmr').value, ssnitMaxInsurable:document.getElementById('psCap').value||0,
          payeBands:bands, payeBandsLabel:document.getElementById('psLabel').value.trim(),
          categories:{ salaries:document.getElementById('psCatS').value.trim(), ssnit:document.getElementById('psCatN').value.trim(), paye:document.getElementById('psCatP').value.trim() } };
        s.safeSubmit(this,function(){ return s.call('savePayrollSettings',{settings:payload}).then(function(r){
          if (!r.success) { document.getElementById('psErr').textContent='❌ '+r.message; return; }
          s._payCfg=r.settings; document.getElementById('psErr').textContent='';
          s.modal.alert('✅ Payroll settings saved. Prepare or recalculate a draft to apply them.');
        }); });
      };
      document.getElementById('psReset').onclick=function(){
        s.modal.confirm('Reset SSNIT, PAYE bands and categories to the Ghana 2026 defaults?').then(function(ok){
          if (ok) s.call('savePayrollSettings',{resetDefaults:true}).then(function(){ s._paySettingsTab(c); });
        });
      };
    }).catch(function(e){ c.innerHTML=s.errHtml(e); });
  },

  /* ── Payslips: two per A4 page (each A5 landscape), cut line between ── */
  _payslipHTML: function(d, l){
    var s=this, E=function(v){ return s.escapeHtml(v===undefined||v===null?'':v); }, sc=d.school||{}, r=d.run;
    var green='#0b5d3b', muted='#5f6b76', line='#d5dbe0', ink='#1b2733';
    var m=function(v){ return (parseFloat(v)||0).toLocaleString('en-GH',{minimumFractionDigits:2,maximumFractionDigits:2}); };
    var crest=sc.crest?'<img src="'+E(sc.crest)+'" style="width:100%;height:100%;object-fit:contain;" alt="">':'<span style="font-size:20pt;">🏫</span>';
    var earn=[['Basic salary',l.basic]].concat((l.allowances||[]).map(function(a){ return [a.name,a.amount]; }));
    if (l.bonus>0) earn.push(['Bonus / extra pay',l.bonus]);
    var cut=[];
    if (l.ssnitApplied) cut.push(['SSNIT ('+((r.settings&&r.settings.ssnitEmployeeRate)||5.5)+'% of basic)',l.ssnitEmployee]);
    if (l.payeApplied) cut.push(['PAYE income tax',l.paye]);
    (l.deductions||[]).forEach(function(a){ cut.push([a.name,a.amount]); });
    if (l.extraDeduction>0) cut.push(['Other deduction'+(l.note?' ('+l.note+')':''),l.extraDeduction]);
    var totalCut=r2(l.ssnitEmployee+l.paye+l.otherDeductions);
    function r2(v){ return Math.round(v*100)/100; }
    var tbl=function(title,rows,totalLabel,total){
      return '<div style="flex:1;min-width:0;"><table style="width:100%;border-collapse:collapse;font-size:8pt;">'+
        '<tr style="background:#f1f5f3;"><td style="padding:1mm 1.5mm;font-size:6.2pt;letter-spacing:.5pt;color:'+muted+';font-weight:700;">'+title+'</td><td style="padding:1mm 1.5mm;font-size:6.2pt;color:'+muted+';text-align:right;">GH₵</td></tr>'+
        (rows.length?rows:[['None','']]).map(function(x){ return '<tr><td style="padding:1mm 1.5mm;border-bottom:.2mm solid '+line+';">'+E(x[0])+'</td><td style="padding:1mm 1.5mm;border-bottom:.2mm solid '+line+';text-align:right;">'+(x[1]===''?'':m(x[1]))+'</td></tr>'; }).join('')+
        '<tr><td style="padding:1.2mm 1.5mm;font-weight:700;">'+totalLabel+'</td><td style="padding:1.2mm 1.5mm;text-align:right;font-weight:700;">'+m(total)+'</td></tr></table></div>';
    };
    var info=[['Staff',l.fullName],['Staff ID',l.staffID],['Position',l.position],['SSNIT no.',l.ssnitNumber],['Ghana Card / TIN',l.ghanaCardTIN],['Paid by',(l.payMethod||'')+(l.accountDetails?' — '+l.accountDetails:'')]];
    return '<div class="payslip" style="width:190mm;height:128mm;box-sizing:border-box;margin:0 auto;background:#fff;color:'+ink+';font-family:\'Segoe UI\',Arial,Helvetica,sans-serif;border:.25mm solid '+line+';border-top:1.6mm solid '+green+';padding:5mm 7mm 4mm;display:flex;flex-direction:column;overflow:hidden;">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:4mm;">'+
        '<div style="display:flex;gap:3mm;align-items:center;min-width:0;"><div style="width:13mm;height:13mm;flex-shrink:0;display:flex;align-items:center;justify-content:center;">'+crest+'</div>'+
          '<div style="min-width:0;"><div style="font-family:Georgia,serif;font-size:12pt;font-weight:700;color:'+green+';text-transform:uppercase;">'+E(sc.name)+'</div>'+
          '<div style="font-size:6.8pt;color:'+muted+';">'+E(sc.address)+(sc.phone?' · '+E(sc.phone):'')+'</div></div></div>'+
        '<div style="text-align:right;flex-shrink:0;"><div style="display:inline-block;border:.35mm solid '+green+';color:'+green+';font-weight:800;font-size:8pt;letter-spacing:1.5pt;padding:.8mm 2.5mm;">PAYSLIP</div>'+
          '<div style="font-size:9pt;font-weight:700;margin-top:1mm;">'+E(d.monthLabel)+'</div>'+
          '<div style="font-size:6.5pt;color:'+muted+';">'+(r.status==='Paid'?'Paid '+E(s.niceDate(r.paidDate)):'DRAFT — not yet paid')+'</div></div></div>'+
      '<div style="border-bottom:.7mm double '+green+';margin:2.5mm 0 2mm;"></div>'+
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1.5mm 4mm;">'+info.map(function(p){ return '<div style="min-width:0;"><div style="font-size:5.8pt;letter-spacing:.5pt;text-transform:uppercase;color:'+muted+';">'+p[0]+'</div><div style="font-size:8pt;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+E(p[1]||'—')+'</div></div>'; }).join('')+'</div>'+
      '<div style="display:flex;gap:5mm;margin-top:3mm;">'+tbl('EARNINGS',earn,'Gross pay',l.gross)+tbl('DEDUCTIONS',cut,'Total deductions',totalCut)+'</div>'+
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:2.5mm;padding:2mm 3mm;background:#f1f7f4;border-left:1mm solid '+green+';">'+
        '<div><div style="font-size:6.2pt;letter-spacing:.6pt;color:'+muted+';">NET PAY</div><div style="font-size:7pt;color:'+muted+';">'+E(s._amountInWords(l.netPay))+'</div></div>'+
        '<div style="font-size:15pt;font-weight:800;color:'+green+';white-space:nowrap;">GH₵ '+m(l.netPay)+'</div></div>'+
      '<div style="font-size:6.6pt;color:'+muted+';margin-top:1.5mm;">'+(l.ssnitApplied?'Employer SSNIT contribution paid by the school (not deducted): GH₵ '+m(l.ssnitEmployer)+' · ':'')+(l.payeApplied?'Taxable pay: GH₵ '+m(l.taxable):'PAYE not applied')+'</div>'+
      '<div style="margin-top:auto;display:flex;justify-content:space-between;gap:10mm;font-size:6.2pt;color:'+muted+';">'+
        '<div style="flex:1;border-top:.25mm solid '+ink+';padding-top:.6mm;">Authorised by</div><div style="flex:1;border-top:.25mm solid '+ink+';padding-top:.6mm;">Received by (staff signature)</div></div>'+
      '<div style="font-size:5.4pt;color:#8a949d;margin-top:1.2mm;text-align:right;">Printed '+E(new Date().toLocaleDateString('en-GB'))+' · iSmartSchool · Confidential</div></div>';
  },
  _printPayslips: function(d, lines){
    var s=this;
    if (!lines.length) return;
    var html=lines.map(function(l,i){
      var brk=(i%2===1&&i<lines.length-1)?'<div style="page-break-after:always;break-after:page;"></div>':'';
      var sep=(i%2===0&&i<lines.length-1)?'<div style="height:6mm;border-bottom:.3mm dashed #b8c0c7;margin:0 0 6mm;position:relative;"><span style="position:absolute;left:0;bottom:-2.2mm;font-size:8pt;color:#b8c0c7;background:#fff;">✂</span></div>':'';
      return s._payslipHTML(d,l)+sep+brk;
    }).join('');
    document.getElementById('printContent').innerHTML=html;
    s.printContent('@page { size: A4 portrait; margin: 10mm; }', true);
  },
  _printPayRegister: function(d){
    var s=this, E=function(v){ return s.escapeHtml(v===undefined||v===null?'':v); }, r=d.run, sc=d.school||{};
    var td=function(v,b){ return '<td style="border:1px solid #ccc;padding:3px 5px;font-size:9pt;'+(b?'font-weight:700;':'')+'">'+v+'</td>'; };
    var m=function(v){ return (parseFloat(v)||0).toLocaleString('en-GH',{minimumFractionDigits:2,maximumFractionDigits:2}); };
    var head=['#','Staff','Position','Basic','Allowances','Bonus','Gross','SSNIT (staff)','PAYE','Other ded.','Net pay','SSNIT (school)','Paid to','Signature'];
    var rows=(d.lines||[]).map(function(l,i){ return '<tr>'+[i+1,E(l.fullName)+'<br><span style="color:#777;font-size:8pt;">'+E(l.staffID)+'</span>',E(l.position),m(l.basic),m(l.allowancesTotal),m(l.bonus),m(l.gross),m(l.ssnitEmployee),m(l.paye),m(l.otherDeductions),'<b>'+m(l.netPay)+'</b>',m(l.ssnitEmployer),E((l.payMethod||'')+(l.accountDetails?' '+l.accountDetails:'')),''].map(function(v){ return td(v); }).join('')+'</tr>'; }).join('');
    var tot='<tr>'+['','Total','',m((d.lines||[]).reduce(function(a,l){return a+l.basic;},0)),m((d.lines||[]).reduce(function(a,l){return a+l.allowancesTotal;},0)),m((d.lines||[]).reduce(function(a,l){return a+l.bonus;},0)),m(r.totalGross),m(r.totalSSNITEmployee),m(r.totalPAYE),m(r.totalOtherDeductions),m(r.totalNet),m(r.totalSSNITEmployer),'',''].map(function(v){ return td(v,true); }).join('')+'</tr>';
    document.getElementById('printContent').innerHTML='<div style="font-family:Arial,sans-serif;color:#1b2733;">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-end;"><div><h2 style="margin:0;color:#0b5d3b;">'+E(sc.name)+'</h2><h3 style="margin:4px 0 10px;">Payroll register — '+E(d.monthLabel)+'</h3></div>'+
      '<div style="text-align:right;font-size:9pt;">Status: <b>'+E(r.status)+'</b>'+(r.status==='Paid'?'<br>Paid '+E(s.niceDate(r.paidDate))+' · '+E(r.payMethod)+(r.reference?' · '+E(r.reference):'')+'<br>'+E(r.vouchers):'')+'</div></div>'+
      '<table style="border-collapse:collapse;width:100%;"><thead><tr>'+head.map(function(h){ return '<th style="border:1px solid #ccc;padding:4px 5px;font-size:8.5pt;background:#f1f5f3;text-align:left;">'+h+'</th>'; }).join('')+'</tr></thead><tbody>'+rows+tot+'</tbody></table>'+
      '<p style="font-size:9pt;margin-top:10px;">Total cost to the school (gross pay + school SSNIT): <b>GH₵ '+m(r.totalCost)+'</b></p>'+
      '<div style="display:flex;gap:30mm;margin-top:18mm;font-size:9pt;"><div style="flex:1;border-top:1px solid #333;padding-top:2px;">Prepared by</div><div style="flex:1;border-top:1px solid #333;padding-top:2px;">Approved by</div></div></div>';
    s.printContent('@page { size: A4 landscape; margin: 10mm; }');
  },

  /* ═══ CANTEEN ═══
     One running account per student: payments add money, each meal served
     deducts the daily rate. Positive = prepaid days left, negative = owes. */
  loadCanteen: function(el){
    var s=this;
    Promise.all([s.getClasses(), s.call('getCanteenSettings')]).then(function(res){
      var cl=res[0], cfg=res[1]; s._cntCfg=cfg;
      var tabs=[['register','🍽️ Daily Register'],['pay','💵 Receive Payment'],['debtors','📒 Debtors'],['expenses','🧾 Expenses'],['reports','📊 Reports']];
      if (s.isAdmin()) tabs.push(['settings','⚙️ Settings']);
      var noRate=!(cfg.defaultRate>0) && !Object.keys(cfg.classRates||{}).some(function(k){ return cfg.classRates[k]>0; });
      el.innerHTML=(noRate?'<div style="background:var(--gold-bg);color:var(--gold);padding:12px 16px;border-radius:12px;margin-bottom:16px;">⚠️ No daily canteen rate is set yet. '+(s.isAdmin()?'Open the <b>Settings</b> tab and enter the daily rate first.':'Ask an Admin to set the daily rate.')+'</div>':'')+
        '<div class="tab-bar">'+tabs.map(function(t,i){ return '<button class="btn tab-btn'+(i===0?' active':'')+'" data-ctab="'+t[0]+'">'+t[1]+'</button>'; }).join('')+'</div>'+
        '<div id="cntContent"></div>';
      var show=function(t, arg){
        el.querySelectorAll('[data-ctab]').forEach(function(b){ b.classList.toggle('active', b.dataset.ctab===t); });
        var c=document.getElementById('cntContent'); c.innerHTML=s.spinner;
        ({register:function(){ s._cntRegister(c,cl); }, pay:function(){ s._cntPay(c,cl,arg); }, debtors:function(){ s._cntDebtors(c,cl); },
          reports:function(){ s._cntReports(c); }, expenses:function(){ s._cntExpenses(c); }, settings:function(){ s._cntSettings(c,cl); }})[t]();
      };
      s._cntShow=show;
      el.querySelectorAll('[data-ctab]').forEach(function(b){ b.onclick=function(){ show(b.dataset.ctab); }; });
      show(noRate && s.isAdmin() ? 'settings' : 'register');
    }).catch(function(e){ el.innerHTML=s.errHtml(e); });
  },
  // "GH₵23.00 credit (4 days + GH₵3.00)" / "Owes GH₵10.00 (2 days)"
  _cntBalanceHtml: function(bal, rate){
    var s=this;
    if (bal < -0.004) { var od=rate>0?Math.ceil(-bal/rate-0.0001):0; return '<span style="color:var(--red);font-weight:700;">Owes '+s.money(-bal)+'</span>'+(rate>0?' <small style="color:var(--text-muted);">('+od+' day'+(od===1?'':'s')+')</small>':''); }
    if (bal > 0.004) return '<span style="color:var(--green);font-weight:700;">'+s.money(bal)+' credit</span>'+(rate>0?' <small style="color:var(--text-muted);">('+s._cntCoverText(bal,rate)+')</small>':'');
    return '<span style="color:var(--text-muted);">Clear</span>';
  },
  _cntCoverText: function(bal, rate){
    if (!(bal>0) || !(rate>0)) return '';
    var d=Math.floor(bal/rate+0.0001), extra=Math.round((bal-d*rate)*100)/100;
    return d+' day'+(d===1?'':'s')+(extra>0?' + '+this.money(extra):'');
  },
  // Same rules as the server: prepaid → credit (if ticked) → pay shortfall today.
  _cntPlan: function(base, rate, credit){
    if (base >= rate - 0.004) return { mode:'prepaid', pay:0 };
    if (credit) return { mode:'credit', pay:0 };
    return { mode:'charged', pay: Math.round((rate - Math.max(0, base))*100)/100 };
  },

  /* ── Today's register: Present = eats, Absent = doesn't ── */
  _cntRegister: function(c, cl){
    var s=this, E=function(v){ return s.escapeHtml(v); };
    var pill='display:inline-block;padding:5px 12px;border-radius:20px;font-size:12px;font-weight:700;white-space:nowrap;';
    c.innerHTML=
      '<h3 style="font-size:22px;margin-bottom:4px;">🍽️ Canteen — Today</h3>'+
      '<p style="color:var(--text-muted);margin-bottom:16px;">Mark who\'s eating today. Payments, balances and arrears are handled automatically.</p>'+
      '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px;">'+
        '<div><label>Class</label><select id="cntRegClass" class="form-control" style="width:auto;min-width:170px;">'+s.classOptions(cl,true,s._cntRegClass||(cl[0]&&cl[0].code)||'All')+'</select></div>'+
        '<div><label>Date</label><input id="cntRegDate" type="date" class="form-control" style="width:170px;" value="'+s.todayYMD()+'" max="'+s.todayYMD()+'"></div>'+
        '<label style="display:flex;gap:8px;align-items:center;background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:11px 14px;margin:5px 0;cursor:pointer;color:var(--text-primary);font-weight:600;"><input type="checkbox" id="cntAllPresent" style="width:16px;height:16px;"> Mark all present</label>'+
      '</div>'+
      '<div id="cntRegSummary" style="display:flex;gap:28px;flex-wrap:wrap;background:var(--bg-secondary);border:1px solid var(--border);border-radius:14px;padding:16px 20px;margin-bottom:14px;"></div>'+
      '<div id="cntRegNote" style="font-size:12px;color:var(--text-muted);margin-bottom:8px;"></div>'+
      '<div id="cntRegList"></div>'+
      '<div class="sticky-save" style="position:sticky;bottom:0;background:var(--bg-card);border-top:1px solid var(--border);padding:12px 0;margin-top:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">'+
        '<span style="font-size:12px;color:var(--text-muted);">Saving is safe to repeat — re-saving only applies what actually changed.</span>'+
        '<button class="btn" id="cntRegSave" style="margin:0;">💾 Save Today\'s Feeding</button></div>';
    var data=null;
    var chip=function(r){
      if (!r.present) return '<span style="'+pill+'background:var(--bg-input);color:var(--text-muted);">Absent — not eating</span>';
      if (!(r.rate>0)) return '<span style="'+pill+'background:var(--red-bg);color:var(--red);">No rate set</span>';
      var p=s._cntPlan(r.base, r.rate, r.credit), cfg=data.settings;
      if (p.mode==='prepaid') { var left=r.base-r.rate; return '<span style="'+pill+'background:var(--green-bg);color:var(--green);">✅ Prepaid'+(left>0.004?' · '+E(s._cntCoverText(left,r.rate))+' left':' · last day')+'</span>'; }
      if (p.mode==='credit') {
        var after=Math.round((r.base-r.rate)*100)/100;
        if (!cfg.allowCredit) return '<span style="'+pill+'background:var(--red-bg);color:var(--red);">⛔ Credit not allowed</span>';
        if (cfg.creditLimit>0 && -after>cfg.creditLimit+0.004) return '<span style="'+pill+'background:var(--red-bg);color:var(--red);">⛔ Over credit limit ('+E(s.money(cfg.creditLimit))+')</span>';
        return '<span style="'+pill+'background:rgba(255,145,0,.15);color:var(--orange);">📝 On credit · will owe '+E(s.money(-after))+'</span>';
      }
      var extra = r.base>0.004 ? ' (uses '+s.money(r.base)+' credit)' : r.base<-0.004 ? ' · still owes '+s.money(-r.base) : '';
      return '<span style="'+pill+'background:var(--gold-bg);color:var(--gold);">💰 Pay '+E(s.money(p.pay))+' today'+E(extra)+'</span>';
    };
    var btnCss=function(on,col){ return 'padding:8px 16px;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;border:1px solid '+(on?col:'var(--border)')+';background:'+(on?'transparent':'var(--bg-input)')+';color:'+(on?col:'var(--text-secondary)')+';'; };
    var paintCard=function(i){
      var r=data.rows[i], card=document.getElementById('cntCard'+i); if (!card) return;
      card.querySelector('.cnt-p').style.cssText=btnCss(r.present,'var(--green)');
      card.querySelector('.cnt-a').style.cssText=btnCss(!r.present,'var(--red)');
      var cr=card.querySelector('.cnt-credit-wrap'), prepaid=r.base>=r.rate-0.004;
      cr.style.visibility = (r.present && !prepaid && r.rate>0) ? 'visible' : 'hidden';
      card.querySelector('.cnt-credit').checked=r.credit;
      card.querySelector('.cnt-credit').disabled=!data.settings.allowCredit;
      card.querySelector('.cnt-chip').innerHTML=chip(r);
    };
    var summary=function(){
      var t={present:0,absent:0,prepaid:0,cash:0,credit:0};
      data.rows.forEach(function(r){
        if (!r.present) { t.absent++; return; }
        t.present++;
        var p=s._cntPlan(r.base, r.rate, r.credit);
        if (p.mode==='prepaid') t.prepaid++; else if (p.mode==='credit') t.credit++; else t.cash+=p.pay;
      });
      document.getElementById('cntRegSummary').innerHTML=[['Present',t.present,'var(--text-primary)'],['Absent',t.absent,'var(--text-primary)'],['Have balance',t.prepaid,'var(--green)'],['Will be charged',s.money(t.cash),'var(--gold)'],['Fed on credit (arrears)',t.credit,'var(--orange)']]
        .map(function(d){ return '<div><div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);">'+d[0]+'</div><div style="font-size:22px;font-weight:800;color:'+d[2]+';">'+d[1]+'</div></div>'; }).join('');
      document.getElementById('cntAllPresent').checked = data.rows.length>0 && t.absent===0;
    };
    var load=function(){
      var list=document.getElementById('cntRegList'); list.innerHTML=s.spinner; data=null;
      s._cntRegClass=document.getElementById('cntRegClass').value;
      s.call('getCanteenRegister',{date:document.getElementById('cntRegDate').value, classCode:s._cntRegClass}).then(function(res){
        if (!res.success) { list.innerHTML='<p style="color:var(--red);padding:20px;text-align:center;">'+E(res.message)+'</p>'; return; }
        data=res;
        document.getElementById('cntRegNote').textContent = res.anySaved ? 'Showing what was saved for this date.' : 'Nothing saved yet for this date — everyone starts as Absent. Tick "Mark all present", then mark the absentees.';
        if (!res.rows.length) { list.innerHTML='<p style="color:var(--text-muted);text-align:center;padding:30px;">No active students in this class.</p>'; summary(); return; }
        var showClass=s._cntRegClass==='All';
        list.innerHTML=res.rows.map(function(r,i){
          return '<div id="cntCard'+i+'" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;background:var(--bg-secondary);border:1px solid var(--border);border-radius:14px;padding:12px 16px;margin-bottom:10px;">'+
            '<div style="min-width:200px;"><div style="font-weight:700;font-size:15px;color:var(--text-primary);">'+E(r.name)+(showClass?' <small style="color:var(--text-muted);font-weight:400;">'+E(r.cls)+'</small>':'')+'</div>'+
              '<div style="font-size:12px;margin-top:2px;">'+s._cntBalanceHtml(r.base, r.rate)+'</div>'+
              '<label class="cnt-credit-wrap" style="display:flex;gap:6px;align-items:center;font-size:12px;margin-top:4px;cursor:pointer;"><input type="checkbox" class="cnt-credit" data-i="'+i+'"> Feed on credit, pay later</label></div>'+
            '<div class="cnt-card-actions" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">'+
              '<button class="cnt-p" data-i="'+i+'">Present</button><button class="cnt-a" data-i="'+i+'">Absent</button>'+
              '<span class="cnt-chip" style="min-width:190px;text-align:right;"></span></div></div>';
        }).join('');
        list.querySelectorAll('.cnt-p').forEach(function(b){ b.onclick=function(){ data.rows[+b.dataset.i].present=true; paintCard(+b.dataset.i); summary(); }; });
        list.querySelectorAll('.cnt-a').forEach(function(b){ b.onclick=function(){ var r=data.rows[+b.dataset.i]; r.present=false; r.credit=false; paintCard(+b.dataset.i); summary(); }; });
        list.querySelectorAll('.cnt-credit').forEach(function(cb){ cb.onchange=function(){ data.rows[+cb.dataset.i].credit=cb.checked; paintCard(+cb.dataset.i); summary(); }; });
        res.rows.forEach(function(r,i){ paintCard(i); });
        summary();
      }).catch(function(e){ list.innerHTML=s.errHtml(e); });
    };
    document.getElementById('cntRegClass').onchange=load;
    document.getElementById('cntRegDate').onchange=load;
    document.getElementById('cntAllPresent').onchange=function(){
      if (!data) return; var on=this.checked;
      data.rows.forEach(function(r,i){ r.present=on; if(!on) r.credit=false; paintCard(i); }); summary();
    };
    document.getElementById('cntRegSave').onclick=function(){
      if (!data || !data.rows.length) { s.modal.alert('Choose a class first.'); return; }
      var entries=data.rows.map(function(r){ return { studentID:r.studentID, present:r.present, credit:r.credit }; });
      s.safeSubmit(this, function(){
        return s.call('saveCanteenRegister',{date:data.date, entries:entries}).then(function(res){
          if (!res.success) { s.modal.alert('❌ '+res.message); return; }
          var blocked=res.blocked||[];
          var html=E('✅ '+res.message)+(blocked.length?'<div style="text-align:left;margin-top:12px;color:var(--red);"><b>Could not be fed:</b><ul style="margin:6px 0 0 18px;">'+blocked.map(function(b){ return '<li>'+E(b.name)+' — '+E(b.reason)+'</li>'; }).join('')+'</ul></div>':'');
          s.modal.show('Feeding Saved', html, [{text:'OK',cb:function(){ load(); }}]);
        });
      });
    };
    load();
  },

  /* ── Receive payment ── */
  _cntPay: function(c, cl, presetSid){
    var s=this;
    s.getStudents().then(function(students){
      var preset=presetSid && s._cache.studentIdx && s._cache.studentIdx[presetSid];
      var cls=preset?preset.Class:'All';
      c.innerHTML='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">'+
          '<select id="cntPayClass" class="form-control" style="width:auto;">'+s.classOptions(cl,true,cls)+'</select>'+
          '<select id="cntPayStudent" class="form-control" style="flex:1;min-width:200px;">'+s.studentOptions(students,cls,'Select student')+'</select></div>'+
        '<div id="cntAccount"><div style="text-align:center;padding:40px;color:var(--text-muted);">Choose a student to see their canteen account.</div></div>';
      var sel=document.getElementById('cntPayStudent');
      document.getElementById('cntPayClass').onchange=function(){ sel.innerHTML=s.studentOptions(students,this.value,'Select student'); document.getElementById('cntAccount').innerHTML=''; };
      sel.onchange=function(){ if (sel.value) s._cntLoadAccount(sel.value); };
      if (preset) { sel.value=presetSid; s._cntLoadAccount(presetSid); }
    }).catch(function(e){ c.innerHTML=s.errHtml(e); });
  },
  _cntOpenPay: function(sid){ if (this._cntShow) this._cntShow('pay', sid); },
  _cntLoadAccount: function(sid){
    var s=this, box=document.getElementById('cntAccount'); if (!box) return;
    box.innerHTML=s.spinner;
    s.call('getCanteenStudentAccount',{sid:sid}).then(function(acc){
      if (!acc.success) { box.innerHTML='<p style="color:var(--red);">'+s.escapeHtml(acc.message)+'</p>'; return; }
      var idemKey=s.newIdemKey(), owes=acc.balance < -0.004;
      box.innerHTML=
        '<div class="fee-card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;">'+
          '<div><h3 style="margin:0;">'+s.escapeHtml(acc.student.name)+'</h3><span style="font-size:13px;color:var(--text-muted);">'+s.escapeHtml(acc.student.cls)+' | '+s.escapeHtml(acc.student.studentID)+'</span></div>'+
          '<div style="font-size:18px;">'+s._cntBalanceHtml(acc.balance, acc.rate)+'</div></div>'+
          '<div class="fee-stats grid-auto">'+
            '<div class="fee-stat"><div class="label">Daily rate</div><div class="value" style="color:var(--blue)">'+(acc.rate>0?s.money(acc.rate):'not set')+'</div></div>'+
            '<div class="fee-stat"><div class="label">Balance</div><div class="value" style="color:'+(owes?'var(--red)':'var(--green)')+'">'+s.money(acc.balance)+'</div></div>'+
            '<div class="fee-stat"><div class="label">'+(owes?'Days owed':'Covers')+'</div><div class="value" style="color:var(--gold);font-size:'+(owes?'20px':'16px')+';">'+(owes?acc.days:(s._cntCoverText(acc.balance,acc.rate)||'0 days'))+'</div></div>'+
          '</div></div>'+
        '<div class="settings-section"><h3>💵 Receive Payment</h3>'+
          '<p style="color:var(--text-muted);font-size:12px;margin-bottom:8px;">Enter the money received. The system works out how many days it covers; any amount left over stays as credit for the next meal.</p>'+
          '<div class="settings-row">'+
            '<div><label>Amount received (GH₵)</label><input id="cntAmt" type="number" min="0.01" step="0.01" class="form-control" placeholder="e.g. 25.00"></div>'+
            '<div><label>Method</label><select id="cntMethod" class="form-control"><option>Cash</option><option>Mobile Money</option><option>Bank</option></select></div>'+
            '<div><label>Reference / MoMo ID</label><input id="cntRef" class="form-control"></div>'+
            '<div><label>Notes (optional)</label><input id="cntNotes" class="form-control"></div></div>'+
          (owes?'<button class="btn btn-secondary btn-sm" id="cntFillDebt" style="padding:6px 14px;margin-top:6px;">Fill exact debt ('+s.money(-acc.balance)+')</button>':'')+
          '<div id="cntPreview" style="margin-top:10px;font-weight:700;color:var(--gold);"></div>'+
          '<div id="cntPayErr" style="color:var(--red);font-size:13px;min-height:18px;margin-top:6px;"></div>'+
          '<button class="btn" id="cntPayBtn">💰 Record Payment</button></div>'+
        '<h4 style="margin:10px 0;">Account history</h4><div id="cntHistory"></div>';
      var amountFor=function(){ return Math.round((parseFloat(document.getElementById('cntAmt').value)||0)*100)/100; };
      var preview=function(){
        var amt=amountFor(), after=Math.round((acc.balance+amt)*100)/100, msg='';
        if (amt>0) {
          var parts=[];
          if (acc.balance<-0.004) parts.push(after>=-0.004?'clears the debt of '+s.money(-acc.balance):'pays '+s.money(amt)+' of the '+s.money(-acc.balance)+' debt');
          if (after>0.004) parts.push(acc.rate>0?'covers '+s._cntCoverText(after,acc.rate):'adds '+s.money(after)+' credit');
          if (after<-0.004) parts.push('still owes '+s.money(-after));
          msg='→ '+s.escapeHtml(parts.join('; '));
        }
        document.getElementById('cntPreview').innerHTML=msg;
      };
      document.getElementById('cntAmt').oninput=preview;
      if (owes) document.getElementById('cntFillDebt').onclick=function(){ document.getElementById('cntAmt').value=(-acc.balance).toFixed(2); preview(); };
      preview();
      document.getElementById('cntPayBtn').onclick=function(){
        var err=document.getElementById('cntPayErr'), amt=amountFor(), method=document.getElementById('cntMethod').value, ref=document.getElementById('cntRef').value.trim();
        err.textContent='';
        if (!(amt>0)) { err.textContent='Enter the amount received.'; return; }
        if (method==='Mobile Money' && !ref) { err.textContent='Enter the MoMo transaction ID.'; return; }
        s.safeSubmit(this, function(){
          return s.call('recordCanteenPayment',{studentID:sid, mode:'amount', amount:amt, method:method, reference:ref,
                                                 notes:document.getElementById('cntNotes').value, idempotencyKey:idemKey}).then(function(res){
            if (!res.success) { err.textContent='❌ '+res.message; return; }
            if (res.queued) {
              s.modal.show('💾 Saved on this device', s.escapeHtml(s.money(amt)+' received while offline. '+res.message), [{text:'OK',cb:function(){ s._cntLoadAccount(sid); }}]);
              return;
            }
            s.modal.show('✅ Payment Saved', s.escapeHtml((res.duplicate?'⚠️ Already recorded — duplicate ignored. ':'')+s.money(res.amount)+' received — '+(res.summary||''))+'<br><small style="color:var(--text-muted);">Receipt '+s.escapeHtml(res.receiptNumber)+'</small>',
              [{text:'Close',cls:'btn-secondary',cb:function(){ s._cntLoadAccount(sid); }},{text:'🖨️ Print Receipt',cb:function(){ s._cntPrintReceipt(res.txId); s._cntLoadAccount(sid); }}]);
          });
        });
      };
      var hist=document.getElementById('cntHistory');
      if (!acc.transactions.length) { hist.innerHTML='<p style="color:var(--text-muted);">No canteen activity yet.</p>'; return; }
      var rows=acc.transactions.map(function(t){
        var tr=document.createElement('tr'), pay=t.type==='PAYMENT', bf=t.type==='OPENING';
        var plus = pay || (bf && t.amount>=0);
        [s.niceDate(t.date), bf?'Brought forward':(pay?'Payment':'Meal'), (plus?'+':'−')+s.money(Math.abs(t.amount)), t.method||'', t.receipt||'', t.notes||''].forEach(function(v,ci){
          var td=tr.insertCell(); td.textContent=v; if(ci===2){ td.style.color=plus?'var(--green)':'var(--red)'; td.style.fontWeight='700'; }
        });
        var td=tr.insertCell();
        if (pay && t.receipt) td.appendChild(s._btn('🖨️','',function(){ s._cntPrintReceipt(t.txId); }));
        if (s.can('canteen.void') && !bf) td.appendChild(s._btn('Void','btn-danger',function(){
          s.modal.confirm('Remove this '+(pay?'payment of ':'meal charge of ')+s.escapeHtml(s.money(t.amount))+' on '+s.escapeHtml(s.niceDate(t.date))+'? This is logged.').then(function(ok){
            if (!ok) return;
            s.call('voidCanteenTransaction',{txId:t.txId}).then(function(r){ if (r.success) s._cntLoadAccount(sid); else s.modal.alert('❌ '+r.message); });
          });
        },'margin-left:4px;'));
        return tr;
      });
      hist.appendChild(s._buildTable(['Date','Type','Amount','Method','Receipt','Notes',''],rows));
    }).catch(function(e){ box.innerHTML=s.errHtml(e); });
  },
  _cntPrintReceipt: function(txId){
    var s=this;
    s.call('getCanteenReceipt',{txId:txId}).then(function(r){
      if (!r) { s.modal.alert('Receipt not found.'); return; }
      var bal=parseFloat(r.balanceNow)||0;
      s._showReceipt(s._receiptHTML({
        title:'CANTEEN RECEIPT', number:r.receipt, date:r.date,
        school:{ name:r.schoolName, motto:r.schoolMotto, address:r.schoolAddress, phone:r.schoolPhone, email:r.schoolEmail, crest:r.schoolCrest },
        payer:[['Student',r.studentName],['Student ID',r.studentID],['Class',r.cls],['Daily rate', r.rate>0?s.money(r.rate):'—']],
        items:[{ desc:'Canteen feeding'+(r.notes?' — '+String(r.notes).split(' — ')[0]:''), amount:r.amount }],
        total:r.amount, method:r.method, reference:r.reference, issuedBy:r.issuedBy,
        summaryTitle:'Canteen account',
        summary: bal<-0.004 ? [['Balance','Owes '+s.money(-bal),'#b42318']]
               : [['Balance', bal>0.004?s.money(bal)+' credit':'Clear', '#0b5d3b']].concat(bal>0.004&&r.rate>0?[['Covers', s._cntCoverText(bal,r.rate)]]:[]),
        note:'Thank you. Credited to the student\'s canteen account.'
      }));
    }).catch(function(e){ s.modal.alert('Error: '+e.message); });
  },

  /* ── Debtors ── */
  _cntDebtors: function(c, cl){
    var s=this;
    c.innerHTML='<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">'+
        '<select id="cntDebtClass" class="form-control" style="width:auto;">'+s.classOptions(cl,true)+'</select>'+
        '<button class="btn btn-secondary" id="cntDebtCsv" style="margin-top:5px;">📥 Export CSV</button>'+
        '<button class="btn btn-secondary" id="cntDebtPrint" style="margin-top:5px;">🖨️ Print List</button></div>'+
      '<div id="cntDebtSummary" class="summary-grid"></div><div id="cntDebtTable"></div>';
    var list=[];
    var render=function(){
      var cf=document.getElementById('cntDebtClass').value;
      var rows=list.filter(function(r){ return cf==='All'||r.cls===cf; });
      var total=rows.reduce(function(a,r){ return a-r.balance; },0);
      document.getElementById('cntDebtSummary').innerHTML=[['Debtors',rows.length,'var(--blue)'],['Total owed',s.money(total),'var(--red)']]
        .map(function(d){ return '<div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:10px;text-transform:uppercase;color:var(--text-muted);">'+d[0]+'</div><div style="font-size:18px;font-weight:800;color:'+d[2]+';">'+d[1]+'</div></div>'; }).join('');
      var wrap=document.getElementById('cntDebtTable'); wrap.innerHTML='';
      if (!rows.length) { wrap.innerHTML='<p style="color:var(--green);text-align:center;padding:30px;">🎉 Nobody owes the canteen.</p>'; return; }
      wrap.appendChild(s._buildTable(['#','Student','Class','Owes','Days owed',''], rows.map(function(r,i){
        var tr=document.createElement('tr');
        [i+1, r.name, r.cls, s.money(-r.balance), r.days].forEach(function(v,ci){ var td=tr.insertCell(); td.textContent=v; if(ci===3){ td.style.color='var(--red)'; td.style.fontWeight='700'; } });
        tr.insertCell().appendChild(s._btn('💵 Receive','',function(){ s._cntOpenPay(r.studentID); }));
        return tr;
      })));
      return rows;
    };
    document.getElementById('cntDebtClass').onchange=render;
    document.getElementById('cntDebtCsv').onclick=function(){
      var rows=render(); if (!rows||!rows.length) return;
      var csv=[['Student ID','Name','Class','Owes (GH₵)','Days owed']].concat(rows.map(function(r){ return [r.studentID,r.name,r.cls,(-r.balance).toFixed(2),r.days]; }))
        .map(function(row){ return row.map(function(v){ v=String(v); if(/^[=+\-@]/.test(v)) v="'"+v; return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }).join(','); }).join('\n');
      var url=URL.createObjectURL(new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8;'})); var a=document.createElement('a'); a.href=url; a.download='canteen_debtors.csv'; a.click(); URL.revokeObjectURL(url);
    };
    document.getElementById('cntDebtPrint').onclick=function(){
      var rows=render(); if (!rows||!rows.length) return;
      var total=rows.reduce(function(a,r){ return a-r.balance; },0);
      s.getConfig().then(function(cfg){
        document.getElementById('printContent').innerHTML='<div style="max-width:700px;margin:0 auto;font-family:Georgia,serif;color:#1a1a1a;">'+
          '<h2 style="text-align:center;color:#006B3F;margin:0;">'+s.escapeHtml(cfg.schoolName)+'</h2><p style="text-align:center;font-weight:700;margin:4px 0 16px;">CANTEEN DEBTORS — '+new Date().toLocaleDateString('en-GB')+'</p>'+
          '<table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr>'+['#','Student','Class','Owes','Days'].map(function(h){ return '<th style="background:#006B3F;color:#fff;padding:7px;text-align:left;">'+h+'</th>'; }).join('')+'</tr></thead><tbody>'+
          rows.map(function(r,i){ return '<tr><td style="padding:6px;border-bottom:1px solid #ddd;">'+(i+1)+'</td><td style="padding:6px;border-bottom:1px solid #ddd;">'+s.escapeHtml(r.name)+'</td><td style="padding:6px;border-bottom:1px solid #ddd;">'+s.escapeHtml(r.cls)+'</td><td style="padding:6px;border-bottom:1px solid #ddd;">'+s.money(-r.balance)+'</td><td style="padding:6px;border-bottom:1px solid #ddd;">'+r.days+'</td></tr>'; }).join('')+
          '<tr><td colspan="3" style="padding:8px;font-weight:700;">TOTAL</td><td colspan="2" style="padding:8px;font-weight:700;color:#CE1126;">'+s.money(total)+'</td></tr></tbody></table></div>';
        App.printContent();
      });
    };
    document.getElementById('cntDebtTable').innerHTML=s.spinner;
    s.call('getCanteenBalances',{classCode:'All'}).then(function(res){
      list=(res.students||[]).filter(function(r){ return r.balance < -0.004; }).sort(function(a,b){ return a.balance-b.balance; });
      render();
    }).catch(function(e){ document.getElementById('cntDebtTable').innerHTML=s.errHtml(e); });
  },

  /* ── Reports ── */
  /* ── Canteen expenses (kept apart from the school's expenses) ── */
  _cntExpenses: function(c){
    var s=this, E=function(v){ return s.escapeHtml(v); }, t=s.todayYMD();
    c.innerHTML='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">'+
        '<button class="btn" id="cxAdd" style="margin:0;">+ Record canteen expense</button><button class="btn btn-secondary" id="cxCats" style="margin:0;">📋 Categories</button></div>'+
      '<div id="cxForm" class="hidden" style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:14px;"></div>'+
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px;">'+
        '<div><label>From</label><input id="cxStart" type="date" class="form-control" style="width:160px;" value="'+t.slice(0,8)+'01"></div>'+
        '<div><label>To</label><input id="cxEnd" type="date" class="form-control" style="width:160px;" value="'+t+'"></div></div>'+
      '<div id="cxTotal" style="font-weight:700;color:var(--red);margin-bottom:8px;"></div><div id="cxList"></div>';
    var cats=[], list=[];
    var form=function(x){
      var f=document.getElementById('cxForm'), idem=s.newIdemKey(); x=x||{};
      var opts=cats.concat(x.category&&cats.indexOf(x.category)<0?[x.category]:[]);
      f.classList.remove('hidden');
      f.innerHTML='<h4 style="margin:0 0 10px;">'+(x.id?'Edit':'Record')+' canteen expense</h4><div class="settings-row">'+
        '<div><label>Date</label><input id="cxDate" type="date" class="form-control" max="'+t+'" value="'+E(x.date||t)+'"></div>'+
        '<div><label>Amount (GH₵)</label><input id="cxAmt" type="number" min="0.01" step="0.01" class="form-control" value="'+E(x.amount||'')+'"></div>'+
        '<div><label>Description</label><input id="cxDesc" class="form-control" placeholder="e.g. 2 bags of rice" value="'+E(x.description||'')+'"></div>'+
        '<div><label>Category</label><select id="cxCat" class="form-control">'+opts.map(function(o){ return '<option'+(o===x.category?' selected':'')+'>'+E(o)+'</option>'; }).join('')+'</select></div>'+
        '<div><label>Paid by</label><input id="cxPaid" class="form-control" value="'+E(x.paidBy||'')+'"></div>'+
        '<div><label>Notes</label><input id="cxNotes" class="form-control" value="'+E(x.notes||'')+'"></div></div>'+
        '<div id="cxErr" style="color:var(--red);font-size:13px;min-height:18px;margin-top:6px;"></div>'+
        '<button class="btn" id="cxSave">💾 Save</button> <button class="btn btn-secondary" id="cxCancel">Cancel</button>';
      document.getElementById('cxCancel').onclick=function(){ f.classList.add('hidden'); f.innerHTML=''; };
      document.getElementById('cxSave').onclick=function(){
        var p={ date:document.getElementById('cxDate').value, amount:parseFloat(document.getElementById('cxAmt').value)||0, description:document.getElementById('cxDesc').value.trim(),
                category:document.getElementById('cxCat').value, paidBy:document.getElementById('cxPaid').value.trim(), notes:document.getElementById('cxNotes').value.trim() };
        var err=document.getElementById('cxErr');
        if (!p.description) { err.textContent='Please enter a description.'; return; }
        if (!(p.amount>0)) { err.textContent='Please enter an amount greater than 0.'; return; }
        if (x.id) p.id=x.id; else p.idempotencyKey=idem;
        s.safeSubmit(this, function(){
          return s.call(x.id?'updateCanteenExpense':'recordCanteenExpense', p).then(function(r){
            if (!r.success) { err.textContent='❌ '+r.message; return; }
            f.classList.add('hidden'); f.innerHTML=''; load();
            s.modal.alert('✅ '+r.message+(r.voucherNumber?' (Voucher '+r.voucherNumber+')':''));
          });
        });
      };
    };
    var render=function(){
      var wrap=document.getElementById('cxList');
      document.getElementById('cxTotal').textContent='Total: '+s.money(list.reduce(function(a,x){ return a+x.amount; },0))+' ('+list.length+' expense'+(list.length===1?'':'s')+')';
      if (!list.length) { wrap.innerHTML='<p style="color:var(--text-muted);text-align:center;padding:24px;">No canteen expenses in this period.</p>'; return; }
      wrap.innerHTML='';
      wrap.appendChild(s._buildTable(['Date','Description','Category','Amount','Voucher',''], list.map(function(x){
        var tr=document.createElement('tr');
        [s.niceDate(x.date), x.description, x.category, s.money(x.amount), x.voucher].forEach(function(v,ci){ var td=tr.insertCell(); td.textContent=v; if (ci===3) { td.style.color='var(--red)'; td.style.fontWeight='700'; } });
        var td=tr.insertCell();
        td.appendChild(s._btn('Edit','',function(){ form(x); document.getElementById('cxForm').scrollIntoView({behavior:'smooth',block:'start'}); }));
        if (s.can('canteen.void')) td.appendChild(s._btn('Del','btn-danger',function(){
          s.modal.confirm('Delete <b>'+E(x.description)+'</b> ('+E(s.money(x.amount))+')?').then(function(ok){
            if (!ok) return; s.call('deleteCanteenExpense',{id:x.id}).then(function(r){ if (r.success) load(); else s.modal.alert('❌ '+r.message); });
          });
        },'margin-left:4px;'));
        return tr;
      })));
    };
    var load=function(){
      document.getElementById('cxList').innerHTML=s.spinner;
      s.call('getCanteenExpenses',{startDate:document.getElementById('cxStart').value, endDate:document.getElementById('cxEnd').value}).then(function(r){
        cats=r.categories||[]; list=r.expenses||[]; render();
      }).catch(function(e){ document.getElementById('cxList').innerHTML=s.errHtml(e); });
    };
    document.getElementById('cxStart').onchange=load; document.getElementById('cxEnd').onchange=load;
    document.getElementById('cxAdd').onclick=function(){ form(); };
    document.getElementById('cxCats').onclick=function(){
      s.modal.show('Canteen expense categories','<p style="font-size:12px;margin-bottom:8px;">One per line.</p><textarea id="cxCatText" class="form-control" rows="8">'+E(cats.join('\n'))+'</textarea><div id="cxCatErr" style="color:var(--red);font-size:13px;"></div>',
        [{text:'Cancel',cls:'btn-secondary'},{text:'Save',cb:function(){
          var v=document.getElementById('cxCatText').value.split('\n').map(function(x){ return x.trim(); }).filter(Boolean);
          s.call('saveCanteenExpenseCategories',{categories:v}).then(function(r){ if (r.success) { s.modal.close(); cats=r.categories; } else document.getElementById('cxCatErr').textContent='❌ '+r.message; });
          return false;
        }}]);
    };
    load();
  },

  /* ── Canteen reports: income, expenses and net for the canteen only ── */
  _cntReports: function(c){
    var s=this, t=s.todayYMD(), E=function(v){ return s.escapeHtml(v); };
    c.innerHTML='<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:16px;">'+
        '<div><label>From</label><input id="cntRepStart" type="date" class="form-control" style="width:160px;" value="'+t.slice(0,8)+'01"></div>'+
        '<div><label>To</label><input id="cntRepEnd" type="date" class="form-control" style="width:160px;" value="'+t+'"></div>'+
        '<button class="btn" id="cntRepGo" style="margin:5px 0;">🔍 Generate</button><button class="btn btn-secondary hidden" id="cntRepPrint" style="margin:5px 0;">🖨️ Print statement</button></div>'+
      '<div id="cntRepOut"></div>';
    var last=null;
    var table=function(headers, rows){ return '<div class="table-wrap"><table class="data-table"><thead><tr>'+headers.map(function(h){ return '<th>'+h+'</th>'; }).join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>'; };
    var none=function(n,txt){ return ['<tr><td colspan="'+n+'" style="color:var(--text-muted)">'+txt+'</td></tr>']; };
    document.getElementById('cntRepGo').onclick=function(){
      var out=document.getElementById('cntRepOut'), st=document.getElementById('cntRepStart').value, en=document.getElementById('cntRepEnd').value;
      if (st && en && st>en) { s.modal.alert('The start date must be before the end date.'); return; }
      out.innerHTML=s.spinner;
      s.call('getCanteenReport',{startDate:st,endDate:en}).then(function(r){
        if (!r.success) { out.innerHTML='<p style="color:var(--red);">'+E(r.message)+'</p>'; return; }
        last=r; document.getElementById('cntRepPrint').classList.remove('hidden');
        var card=function(l,v,col){ return '<div class="stat-card"><div class="stat-value" style="color:'+col+';font-size:20px;">'+v+'</div><div class="stat-label">'+l+'</div></div>'; };
        var cats=Object.keys(r.expensesByCategory||{}).sort();
        out.innerHTML='<div class="summary-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));">'+
            card('Income (cash received)',s.money(r.cashReceived),'var(--green)')+card('Expenses',s.money(r.totalExpenses),'var(--red)')+
            card(r.net>=0?'Net surplus':'Net deficit',s.money(Math.abs(r.net)),r.net>=0?'var(--green)':'var(--red)')+
            card('Meals served',r.mealsServed,'var(--blue)')+card('Meals on credit',r.creditMeals,'var(--orange)')+
            card('Owed now ('+r.debtorsNow+')',s.money(r.owedNow),'var(--red)')+card('Prepaid credit now',s.money(r.prepaidNow),'var(--teal)')+'</div>'+
          '<div class="two-col" style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:10px;">'+
            '<div><h4>Income by payment method</h4>'+table(['Method','Amount'], Object.keys(r.byMethod).map(function(k){ return '<tr><td>'+E(k)+'</td><td>'+s.money(r.byMethod[k])+'</td></tr>'; }).concat(Object.keys(r.byMethod).length?[]:none(2,'No payments')))+'</div>'+
            '<div><h4>Expenses by category</h4>'+table(['Category','Amount'], cats.map(function(k){ return '<tr><td>'+E(k)+'</td><td>'+s.money(r.expensesByCategory[k])+'</td></tr>'; }).concat(cats.length?[]:none(2,'No expenses')))+'</div></div>'+
          '<h4 style="margin-top:20px;">By class</h4>'+table(['Class','Meals','Meal value','Cash'], r.byClass.map(function(x){ return '<tr><td>'+E(x.cls)+'</td><td>'+x.meals+'</td><td>'+s.money(x.mealsValue)+'</td><td>'+s.money(x.cash)+'</td></tr>'; }).concat(r.byClass.length?[]:none(4,'No activity')))+
          '<h4 style="margin-top:20px;">By day</h4>'+table(['Date','Meals','Cash received','Expenses'], r.byDay.map(function(x){ return '<tr><td>'+E(s.niceDate(x.date))+'</td><td>'+x.meals+'</td><td>'+s.money(x.cash)+'</td><td>'+s.money(x.expenses||0)+'</td></tr>'; }).concat(r.byDay.length?[]:none(4,'No activity in this period')))+
          '<p style="color:var(--text-muted);font-size:12px;margin-top:10px;">Canteen money is kept separate from the school\'s Finances and Expenses.</p>';
      }).catch(function(e){ out.innerHTML=s.errHtml(e); });
    };
    document.getElementById('cntRepPrint').onclick=function(){
      if (!last) return; var r=last;
      var cell='padding:6px 10px;border-bottom:1px solid #e3e3e3;font-size:12px;';
      var rows=function(list){ return list.map(function(rw){ return '<tr><td style="'+cell+'">'+E(rw[0])+'</td><td style="'+cell+'text-align:right;">'+E(rw[1])+'</td></tr>'; }).join(''); };
      var block=function(title,col,list,totalLabel,total){ return '<h4 style="color:'+col+';border-bottom:1px solid #ddd;padding-bottom:5px;margin:18px 0 4px;">'+title+'</h4><table style="width:100%;border-collapse:collapse;">'+
        (list.length?rows(list):'<tr><td style="'+cell+'color:#888;">None recorded</td><td style="'+cell+'"></td></tr>')+
        '<tr><td style="padding:8px 10px;font-weight:700;border-top:2px solid '+col+';">'+totalLabel+'</td><td style="padding:8px 10px;font-weight:700;text-align:right;border-top:2px solid '+col+';">'+s.money(total)+'</td></tr></table>'; };
      document.getElementById('printContent').innerHTML='<div style="max-width:700px;margin:0 auto;font-family:Georgia,serif;color:#1a1a1a;">'+
        '<div style="text-align:center;border-bottom:2px solid #0b5d3b;padding-bottom:10px;"><h2 style="color:#0b5d3b;margin:0;text-transform:uppercase;">'+E(r.schoolName)+'</h2>'+
        '<p style="font-weight:700;margin:6px 0 2px;letter-spacing:.5px;">CANTEEN — INCOME &amp; EXPENDITURE</p><p style="font-size:12px;color:#555;margin:0;">'+E((r.startDate?s.niceDate(r.startDate):'Start')+' to '+s.niceDate(r.endDate))+'</p></div>'+
        block('Income','#0b5d3b', Object.keys(r.byMethod).map(function(k){ return ['Canteen payments — '+k, s.money(r.byMethod[k])]; }),'Total income', r.cashReceived)+
        block('Expenditure','#b42318', Object.keys(r.expensesByCategory||{}).sort().map(function(k){ return [k, s.money(r.expensesByCategory[k])]; }),'Total expenditure', r.totalExpenses)+
        '<div style="margin-top:18px;padding:14px 18px;background:#f5f5f5;border-radius:6px;display:flex;justify-content:space-between;font-weight:700;"><span>'+(r.net>=0?'Net surplus':'Net deficit')+'</span><span style="font-size:18px;color:'+(r.net>=0?'#0b5d3b':'#b42318')+';">'+s.money(Math.abs(r.net))+'</span></div>'+
        '<table style="width:100%;border-collapse:collapse;margin-top:18px;font-size:12px;">'+rows([['Meals served',r.mealsServed],['Meals on credit',r.creditMeals],['Owed by students now ('+r.debtorsNow+')',s.money(r.owedNow)],['Prepaid credit held now',s.money(r.prepaidNow)]])+'</table>'+
        '<p style="margin-top:24px;font-size:10px;color:#999;text-align:center;">Prepared by iSmartSchool — '+new Date().toLocaleDateString('en-GB')+'</p></div>';
      App.printContent();
    };
    document.getElementById('cntRepGo').click();
  },
  /* ── Settings (Admin) ── */
  _cntSettings: function(c, cl){
    var s=this;
    s.call('getCanteenSettings').then(function(cfg){
      s._cntCfg=cfg;
      c.innerHTML='<div class="settings-section"><h3>🍽️ Daily Rate</h3><div class="settings-row">'+
          '<div><label>Default cost of one day\'s meal (GH₵)</label><input id="cntRate" type="number" min="0" step="0.01" class="form-control" value="'+s.escapeHtml(cfg.defaultRate)+'"></div></div>'+
          '<p style="color:var(--text-muted);font-size:12px;margin-top:6px;">Optional: give a class its own rate below. Leave blank to use the default.</p>'+
          '<div id="cntClassRates"></div></div>'+
        '<div class="settings-section"><h3>💳 Feeding on Credit</h3>'+
          '<label style="display:flex;gap:8px;align-items:center;"><input type="checkbox" id="cntAllowCredit"'+(cfg.allowCredit?' checked':'')+' style="width:18px;height:18px;"> Allow students to eat now and pay later</label>'+
          '<div class="settings-row" style="margin-top:10px;"><div><label>Maximum a student may owe (GH₵, 0 = no limit)</label><input id="cntLimit" type="number" min="0" step="0.01" class="form-control" value="'+s.escapeHtml(cfg.creditLimit)+'"></div></div></div>'+
        '<button class="btn" id="cntSaveSettings" style="width:100%;padding:14px;">💾 Save Canteen Settings</button>'+
        '<div id="cntSetMsg" style="text-align:center;margin-top:10px;font-size:13px;"></div>';
      document.getElementById('cntClassRates').appendChild(s._buildTable(['Class','Rate (GH₵)'], cl.map(function(x){
        var tr=document.createElement('tr'); tr.insertCell().textContent=x.name+' ('+x.code+')';
        var inp=document.createElement('input'); inp.type='number'; inp.min='0'; inp.step='0.01'; inp.className='form-control cnt-class-rate'; inp.style.cssText='margin:0;max-width:160px;';
        inp.dataset.code=x.code; inp.placeholder='default'; inp.value=(cfg.classRates && cfg.classRates[x.code]!==undefined)?cfg.classRates[x.code]:'';
        tr.insertCell().appendChild(inp); return tr;
      })));
      document.getElementById('cntSaveSettings').onclick=function(){
        var msg=document.getElementById('cntSetMsg'), rate=parseFloat(document.getElementById('cntRate').value), limit=parseFloat(document.getElementById('cntLimit').value||'0');
        if (isNaN(rate)||rate<0) { msg.style.color='var(--red)'; msg.textContent='❌ Enter a valid daily rate.'; return; }
        if (isNaN(limit)||limit<0) { msg.style.color='var(--red)'; msg.textContent='❌ Credit limit must be 0 or more.'; return; }
        var classRates={};
        document.querySelectorAll('.cnt-class-rate').forEach(function(i){ if (i.value!=='') classRates[i.dataset.code]=parseFloat(i.value); });
        s.safeSubmit(this, function(){
          return s.call('saveCanteenSettings',{defaultRate:rate, classRates:classRates, allowCredit:document.getElementById('cntAllowCredit').checked, creditLimit:limit}).then(function(r){
            msg.style.color=r.success?'var(--green)':'var(--red)'; msg.textContent=(r.success?'✅ ':'❌ ')+r.message;
          });
        });
      };
    }).catch(function(e){ c.innerHTML=s.errHtml(e); });
  },

  /* ── Roles & Permissions: the Admin defines roles and what each can do ── */
  loadPermissionsTab: function(c){
    var s=this, E=function(v){ return s.escapeHtml(v); };
    c.innerHTML=s.spinner;
    s.call('getRolePermissions').then(function(cfg){
      var card=function(role, isNew){
        var id='rc'+Math.random().toString(36).slice(2,8);
        var boxes=function(list, kind, on){ return list.map(function(p){
          if (p.adminOnly) return '<label style="display:flex;gap:8px;align-items:center;padding:6px 0;color:var(--text-muted);font-size:13px;"><input type="checkbox" disabled style="width:18px;height:18px;"> '+E(p.label)+' <span style="font-size:11px;">(Admin only)</span></label>';
          return '<label style="display:flex;gap:8px;align-items:center;padding:6px 0;cursor:pointer;color:var(--text-primary);font-size:13px;"><input type="checkbox" class="'+id+'-'+kind+'" value="'+E(p.key)+'"'+(on.indexOf(p.key)>=0?' checked':'')+' style="width:18px;height:18px;flex-shrink:0;"> '+E(p.label)+'</label>';
        }).join(''); };
        return '<div class="settings-section" data-card="'+id+'">'+
          '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">'+
            '<input class="form-control '+id+'-name" value="'+E(role.name)+'" placeholder="Role name, e.g. Bursar" maxlength="30" style="flex:1;min-width:180px;font-weight:700;margin:0;">'+
            (isNew?'<span class="role-badge" style="background:var(--green-bg);color:var(--green);">New</span>':'<span style="color:var(--text-muted);font-size:12px;">'+role.users+' user'+(role.users===1?'':'s')+'</span>')+'</div>'+
          '<div class="two-col" style="display:grid;grid-template-columns:1fr 1fr;gap:6px 20px;">'+
            '<div><div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">Pages</div>'+boxes(cfg.pages,'p',role.pages)+'</div>'+
            '<div><div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">Actions</div>'+boxes(cfg.actions,'a',role.actions)+'</div></div>'+
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">'+
            '<button class="btn '+id+'-save" style="margin:0;">💾 '+(isNew?'Create role':'Save')+'</button>'+
            (isNew?'<button class="btn btn-secondary '+id+'-cancel" style="margin:0;">Cancel</button>':'<button class="btn btn-danger '+id+'-del" style="margin:0;"'+(role.users?' title="Give its users another role first"':'')+'>🗑️ Delete</button>')+
          '</div><div class="'+id+'-msg" style="font-size:13px;margin-top:8px;"></div></div>';
      };
      var wire=function(role, isNew){
        var el=c.querySelector('[data-card]:not([data-wired])'); el.setAttribute('data-wired','1');
        var id=el.getAttribute('data-card'), q=function(x){ return el.querySelector('.'+id+'-'+x); }, msg=q('msg');
        var vals=function(k){ return Array.prototype.map.call(el.querySelectorAll('.'+id+'-'+k+':checked'), function(i){ return i.value; }); };
        q('save').onclick=function(){
          var name=q('name').value.trim();
          if (!name) { msg.style.color='var(--red)'; msg.textContent='Please give the role a name.'; return; }
          if (!vals('p').length) { msg.style.color='var(--red)'; msg.textContent='Tick at least one page.'; return; }
          s.safeSubmit(this, function(){
            return s.call('saveRole',{name:name, originalName:isNew?'':role.name, pages:vals('p'), actions:vals('a')}).then(function(r){
              if (!r.success) { msg.style.color='var(--red)'; msg.textContent='❌ '+r.message; return; }
              s.modal.alert('✅ '+r.message).then(function(){ s.loadPermissionsTab(c); });
            });
          });
        };
        if (isNew) q('cancel').onclick=function(){ el.remove(); };
        else q('del').onclick=function(){
          if (role.users) { msg.style.color='var(--red)'; msg.textContent='❌ '+role.users+' user(s) still have this role. Change their role under Users first.'; return; }
          s.modal.confirm('Delete the role <b>'+E(role.name)+'</b>?').then(function(ok){
            if (!ok) return;
            s.call('deleteRole',{name:role.name}).then(function(r){ if (r.success) s.loadPermissionsTab(c); else { msg.style.color='var(--red)'; msg.textContent='❌ '+r.message; } });
          });
        };
      };
      c.innerHTML=
        '<div class="settings-section"><h3>🔐 Roles &amp; Permissions</h3>'+
          '<p style="color:var(--text-muted);font-size:13px;">Create a role for each kind of staff (e.g. Bursar, Class Teacher, Canteen Staff), tick what it can do, then give users that role under <b>Users</b>. The server enforces these rules on every action, not just the menu. Changes apply the next time a user refreshes or logs in.</p>'+
          '<p style="margin-top:10px;font-size:13px;"><span class="role-badge Admin">Admin</span> <span style="color:var(--text-muted);">is built in: full access, including Settings, users and term rollover ('+cfg.adminUsers+' user'+(cfg.adminUsers===1?'':'s')+'). It cannot be edited or deleted.</span></p>'+
          '<button class="btn" id="newRoleBtn" style="margin-top:12px;">+ New role</button></div>'+
        '<div id="newRoleSlot"></div><div id="roleCards"></div>';
      var holder=document.getElementById('roleCards');
      cfg.roles.forEach(function(r){ holder.insertAdjacentHTML('beforeend', card(r,false)); wire(r,false); });
      if (!cfg.roles.length) holder.innerHTML='<p style="color:var(--text-muted);text-align:center;padding:20px;">No roles yet — only Admins can sign in. Click <b>+ New role</b>.</p>';
      document.getElementById('newRoleBtn').onclick=function(){
        var slot=document.getElementById('newRoleSlot');
        if (slot.querySelector('[data-card]')) return;
        var blank={ name:'', pages:['students'], actions:[], users:0 };
        slot.innerHTML=card(blank,true); wire(blank,true);
        slot.querySelector('input').focus();
      };
    }).catch(function(e){ c.innerHTML=s.errHtml(e); });
  },
  // Badge colour for any role name (Admin is always red).
  roleBadge: function(role){
    var span=document.createElement('span'); span.className='role-badge'; span.textContent=role||'(no role)';
    if (role==='Admin') span.classList.add('Admin');
    else { var pal=[['var(--gold-bg)','var(--gold)'],['var(--blue-bg)','var(--blue)'],['var(--green-bg)','var(--green)'],['rgba(124,77,255,.15)','var(--purple)'],['rgba(255,145,0,.15)','var(--orange)']];
      var h=0; String(role).split('').forEach(function(ch){ h=(h*31+ch.charCodeAt(0))>>>0; }); var p=pal[h%pal.length];
      span.style.background=p[0]; span.style.color=p[1]; }
    return span;
  },
  // Runs the archive one sheet/chunk at a time; onProgress(text) is called as it goes.
  runArchive: function(onProgress){
    var s=this, sheets=['Attendance','Results_Entry','Conduct_Records','Student_Fee_Overrides','Canteen_Ledger'], moved=0, idx=0, rounds=0;
    return new Promise(function(resolve, reject){
      var step=function(){
        if (idx>=sheets.length) { s.call('getDataHealth').then(function(){ resolve(moved); }, function(){ resolve(moved); }); return; }
        var name=sheets[idx];
        onProgress('⏳ Archiving '+name.replace(/_/g,' ')+'… ('+moved.toLocaleString()+' rows moved so far)');
        s.call('archiveClosedTerms',{sheet:name}).then(function(r){
          if (!r.success) throw new Error(r.message);
          moved+=r.archived||0;
          if (r.remaining>0 && ++rounds<200) step(); else { idx++; rounds=0; step(); }
        }).catch(reject);
      };
      step();
    });
  },
  openSettingsTab: function(tab){
    this.switchPage('settings');
    var s=this; setTimeout(function(){ s.loadSettings(document.getElementById('pageBody'), tab); }, 0);
  },
  /* ── Data: sheet size, compaction and archiving of closed terms ── */
  loadDataTab: function(c){
    var s=this, E=function(v){ return s.escapeHtml(v); };
    c.innerHTML=s.spinner;
    s.call('getDataHealth').then(function(d){
      var pct=d.percent, col=pct>=80?'var(--red)':pct>=50?'var(--gold)':'var(--green)';
      var closed=d.sheets.filter(function(x){ return x.closedRows>0; }).reduce(function(a,x){ return a+x.closedRows; },0);
      var fmt=function(n){ return Number(n).toLocaleString(); };
      var rows=d.sheets.map(function(x){
        return '<tr><td>'+E(x.name)+'</td><td style="text-align:right;">'+fmt(x.rows)+'</td><td style="text-align:right;">'+fmt(x.cells)+'</td><td style="text-align:right;color:'+(x.closedRows?'var(--gold)':'var(--text-muted)')+';">'+(d.archiveSheets.indexOf(x.name)>=0?fmt(x.closedRows):'—')+'</td></tr>';
      }).join('');
      c.innerHTML=
        (d.pending.length?'<div style="background:var(--gold-bg);color:var(--gold);padding:12px 16px;border-radius:12px;margin-bottom:16px;">⚠️ An archive run was interrupted ('+E(d.pending.join(', '))+'). Click <b>Archive closed terms</b> to finish it safely.</div>':'')+
        '<div class="settings-section"><h3>📦 Spreadsheet capacity</h3>'+
          '<p style="color:var(--text-muted);font-size:13px;margin-bottom:10px;">Google Sheets allows 10 million cells per spreadsheet, and every screen gets slower as sheets grow. Attendance and canteen add one row per student per school day.</p>'+
          '<div style="background:var(--bg-input);border-radius:10px;height:18px;overflow:hidden;"><div style="height:100%;width:'+Math.min(100,pct)+'%;background:'+col+';"></div></div>'+
          '<p style="margin-top:8px;font-weight:700;color:'+col+';">'+pct+'% used — '+fmt(d.totalCells)+' of '+fmt(d.cellLimit)+' cells</p>'+
          '<p style="color:var(--text-muted);font-size:12px;">'+fmt(d.wastedCells)+' of those cells are empty space that <b>Compact</b> can free.</p></div>'+
        '<div class="settings-section"><h3>🧹 Compact &amp; 🗄️ Archive</h3>'+
          '<p style="color:var(--text-muted);font-size:13px;margin-bottom:6px;"><b>Compact</b> removes unused empty rows and columns. It never touches data.</p>'+
          '<p style="color:var(--text-muted);font-size:13px;margin-bottom:6px;"><b>Archive closed terms</b> moves attendance, results, conduct, fee overrides and canteen rows from terms <i>before</i> '+E(s.TERM_NAMES[d.term]||('Term '+d.term))+' '+E(d.academicYear)+' into a separate archive spreadsheet for each academic year. Nothing on screen changes: report cards and registers only use the current term, canteen balances are carried forward, and canteen totals stay in reports.</p>'+
          '<p style="color:var(--gold);font-size:12px;margin-bottom:12px;">Best done after the term rollover and once report cards are printed, at a quiet time — other users may see "system busy" while it runs. Archived dates can no longer be edited.</p>'+
          '<div style="display:flex;gap:10px;flex-wrap:wrap;">'+
            '<button class="btn btn-secondary" id="dataCompactBtn" style="margin:0;">🧹 Compact sheets</button>'+
            '<button class="btn" id="dataArchiveBtn" style="margin:0;"'+(closed||d.pending.length?'':' disabled')+'>🗄️ Archive closed terms ('+fmt(closed)+' rows)</button>'+
          '</div><div id="dataProgress" style="margin-top:12px;font-size:13px;"></div>'+
          ((d.archiveFiles||[]).length?'<div style="margin-top:12px;font-size:13px;"><b>📁 Archive files</b> <span style="color:var(--text-muted);">(one per academic year'+(d.lastArchiveAt?' — last archived '+E(String(d.lastArchiveAt).slice(0,10)):'')+')</span><ul style="margin:6px 0 0 18px;">'+
            d.archiveFiles.map(function(f){ return '<li><a href="'+E(f.url)+'" target="_blank" rel="noopener" style="color:var(--green);">'+E(f.label)+'</a></li>'; }).join('')+'</ul></div>':'')+
        '</div>'+
        '<div class="settings-section"><h3>📊 Sheets</h3><div class="table-wrap"><table class="data-table"><thead><tr><th>Sheet</th><th style="text-align:right;">Rows</th><th style="text-align:right;">Cells</th><th style="text-align:right;">Closed-term rows</th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
      var prog=document.getElementById('dataProgress');
      document.getElementById('dataCompactBtn').onclick=function(){
        s.safeSubmit(this, function(){
          return s.call('compactSheets').then(function(r){ prog.style.color='var(--green)'; prog.textContent='✅ '+r.message; setTimeout(function(){ s.loadDataTab(c); },1200); });
        });
      };
      document.getElementById('dataArchiveBtn').onclick=function(){
        var btn=this;
        s.showDangerConfirm({ icon:'🗄️', title:'Archive closed terms?', subtitle:'Rows from earlier terms move to the archive spreadsheet.',
          warnings:['Dates in archived terms can no longer be edited (attendance, canteen).','Past-term results and attendance are then read from the archive spreadsheet.','Run it when few people are using the system.'],
          keyword:'ARCHIVE', confirmLabel:'🗄️ Archive now', confirmColor:'var(--green)',
          onConfirm:function(){
            btn.disabled=true; prog.style.color='var(--text-secondary)';
            s.runArchive(function(t){ prog.textContent=t; }).then(function(moved){
              prog.style.color='var(--green)'; prog.textContent='✅ Done — '+fmt(moved)+' rows archived.'; setTimeout(function(){ s.loadDataTab(c); }, 900);
            }).catch(function(e){ prog.style.color='var(--red)'; prog.textContent='❌ '+e.message+' — click Archive again to continue; nothing is lost.'; btn.disabled=false; });
          } });
      };
    }).catch(function(e){ c.innerHTML=s.errHtml(e); });
  },
  /* ── Excel results template (built and read in the browser) ── */
  loadExcelJS: function(){
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    // Served from this site (and cached for offline use) instead of a CDN.
    var urls=['assets/vendor/exceljs.min.js'];
    return new Promise(function(resolve, reject){
      var i=0;
      var next=function(){
        if (i>=urls.length) { reject(new Error('Could not load the Excel tool. Open this page once while online so it is saved for offline use, then try again.')); return; }
        var sc=document.createElement('script'); sc.src=urls[i++];
        sc.onload=function(){ if (window.ExcelJS) resolve(window.ExcelJS); else next(); };
        sc.onerror=next; document.head.appendChild(sc);
      };
      next();
    });
  },
  // Only the score cells and the Conduct column can be edited; everything
  // else is locked. Scores must be 0–100; conduct is picked from a list.
  _buildResultsWorkbook: function(ExcelJS, t){
    var wb=new ExcelJS.Workbook(); wb.creator='iSmartSchool'; wb.created=new Date();
    var ws=wb.addWorksheet('Results',{ views:[{ state:'frozen', xSplit:2, ySplit:3 }], properties:{ defaultRowHeight:18 } });
    var lists=wb.addWorksheet('Lists',{ state:'veryHidden' });
    t.conductOptions.forEach(function(o,i){ lists.getCell(i+1,1).value=o; });
    var n=t.headers.length, scoreFrom=3, scoreTo=n-1, conductCol=n, last=3+t.rows.length;
    var green='FF0B5D3B', thin={ style:'thin', color:{ argb:'FFC9D2DB' } }, border={ top:thin, left:thin, bottom:thin, right:thin };
    ws.mergeCells(1,1,1,n);
    var title=ws.getCell(1,1);
    title.value=t.schoolName+' — '+t.className+' ('+t.classCode+') — '+(this.TERM_NAMES[t.term]||('Term '+t.term))+' '+t.academicYear;
    title.font={ bold:true, size:13, color:{ argb:green } };
    ws.mergeCells(2,1,2,n);
    var note=ws.getCell(2,1);
    note.value='Type scores out of 100 in the white cells (blank = keep the saved score). Pick conduct from the dropdown. Names and IDs are locked. Save and upload this file under Results → Upload.';
    note.font={ italic:true, size:9, color:{ argb:'FF5F6B76' } }; note.alignment={ wrapText:true, vertical:'middle' };
    ws.getRow(2).height=30;
    var head=ws.getRow(3); head.height=48;
    t.headers.forEach(function(h,i){
      var c=head.getCell(i+1); c.value=h;
      c.font={ bold:true, color:{ argb:'FFFFFFFF' }, size:10 };
      c.fill={ type:'pattern', pattern:'solid', fgColor:{ argb: i+1===conductCol ? 'FF1F3B57' : green } };
      c.alignment={ wrapText:true, vertical:'middle', horizontal: i<2?'left':'center' }; c.border=border;
    });
    t.rows.forEach(function(r,k){
      var row=ws.getRow(4+k);
      r.forEach(function(v,i){
        var c=row.getCell(i+1), col=i+1;
        c.value=(v===''||v===null||v===undefined)?null:v;
        c.border=border;
        if (col<scoreFrom) { c.fill={ type:'pattern', pattern:'solid', fgColor:{ argb:'FFF1F5F3' } }; c.font={ bold:col===2 }; }
        else if (col<=scoreTo) {
          c.protection={ locked:false }; c.alignment={ horizontal:'center' };
          c.dataValidation={ type:'decimal', operator:'between', allowBlank:true, formulae:[0,100], showErrorMessage:true, errorStyle:'stop', errorTitle:'Score out of 100', error:'Enter a number from 0 to 100.' };
        } else {
          c.protection={ locked:false };
          c.dataValidation={ type:'list', allowBlank:true, formulae:['Lists!$A$1:$A$'+t.conductOptions.length], showErrorMessage:true, errorStyle:'stop', errorTitle:'Conduct', error:'Please choose a conduct from the list.' };
        }
      });
    });
    ws.getColumn(1).width=16; ws.getColumn(2).width=28;
    for (var c=scoreFrom;c<=scoreTo;c++) ws.getColumn(c).width=12;
    ws.getColumn(conductCol).width=34;
    var pw='iSS-'+t.classCode+'-'+t.academicYear;
    // spinCount 1000 (not the library's default 100000): the default made the
    // password hashing take many seconds and froze the page on slower PCs.
    return Promise.all([
      ws.protect(pw,{ selectLockedCells:true, selectUnlockedCells:true, formatColumns:true, formatRows:true, spinCount:1000 }),
      lists.protect(pw,{ spinCount:1000 })
    ]).then(function(){ return wb.xlsx.writeBuffer(); });
  },
  // Reads the Results sheet back into plain rows of text.
  _readResultsWorkbook: function(ExcelJS, buffer){
    var wb=new ExcelJS.Workbook();
    return wb.xlsx.load(buffer).then(function(){
      var ws=wb.getWorksheet('Results')||wb.worksheets[0];
      if (!ws) throw new Error('No sheet found');
      var rows=[], cols=ws.columnCount;
      ws.eachRow({ includeEmpty:true }, function(row, rn){
        var arr=[];
        for (var c=1;c<=cols;c++) {
          var v=row.getCell(c).value;
          if (v && typeof v==='object') v = v.result!==undefined ? v.result : v.richText ? v.richText.map(function(x){ return x.text; }).join('') : v.text!==undefined ? v.text : '';
          arr.push(v===null||v===undefined?'':String(v));
        }
        rows[rn-1]=arr;
      });
      for (var i=0;i<rows.length;i++) if (!rows[i]) rows[i]=[];
      return rows;
    });
  },
  /* ═══ CURRICULUM ═══ */
  loadCurriculum: function(el){
    el.innerHTML='<h3 style="margin-bottom:16px;">GES 9-Point Grading Scale</h3><div class="summary-grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));">'+
      [[1,'Excellent','80–100%','#00c853'],[2,'Very Good','70–79%','#00bcd4'],[3,'Good','65–69%','#7c4dff'],
       [4,'High Average','60–64%','#ff9100'],[5,'Average','55–59%','#ffc107','#000'],[6,'Low Average','50–54%','#ff9800'],
       [7,'Pass','45–49%','#e91e63'],[8,'Pass (Low)','40–44%','#9c27b0'],[9,'Fail','0–39%','#ff3d5a']]
      .map(function(g){ return '<div style="background:'+g[3]+';color:'+(g[4]||'white')+';padding:20px;border-radius:12px;font-weight:600;">Grade '+g[0]+' – '+g[1]+'<br><small>'+g[2]+'</small></div>'; }).join('')+'</div>';
  }
};

/* ── Mobile: every data table becomes a list of labelled cards on narrow
   screens (CSS does the layout; this adds the labels). Runs automatically
   whenever a page draws a table. Report-card previews are scaled to fit. ── */
App.cardifyTables = function(root){
  (root||document).querySelectorAll('table.data-table').forEach(function(t){
    if (!t._mCols) {
      if (t.closest('.report-preview,#printContent,.no-cards')) { t._mCols='skip'; return; }
      var ths=[].slice.call(t.querySelectorAll('thead th')).map(function(th){ return th.textContent.trim(); });
      if (ths.length<3) { t._mCols='skip'; return; }
      var ti=ths.findIndex(function(h){ return /name|staff|student|description|subject|component|category|^class$|^item|sheet|^role|^source/i.test(h) && !/id$/i.test(h); });
      if (ti<0) ti=(ths[0]==='#'?1:0);
      t._mCols={ ths:ths, title:ti };
      t.classList.add('m-cards');
    }
    if (t._mCols==='skip') return;
    var ths=t._mCols.ths, ti=t._mCols.title;
    t.querySelectorAll('tbody tr:not(.m-row)').forEach(function(tr){
      tr.classList.add('m-row');
      var col=0;
      [].slice.call(tr.children).forEach(function(td){
        var span=parseInt(td.getAttribute('colspan'),10)||1, h=ths[col]||'';
        col+=span;
        if (span>1) { td.classList.add('m-full'); return; }
        td.setAttribute('data-label', h);
        var txt=td.textContent; td.querySelectorAll('button,a').forEach(function(x){ txt=txt.replace(x.textContent,''); });
        var onlyButtons=!!td.querySelector('button') && !txt.trim() && !td.querySelector('input,select');
        if (h==='#') td.classList.add('m-idx');
        else if (col-span===ti && !onlyButtons) td.classList.add('m-title');
        else if (onlyButtons || /^actions?$/i.test(h)) td.classList.add('m-actions');
        else if (!h) td.classList.add('m-nolabel');
        if (!td.textContent.trim() && !td.children.length) td.classList.add('m-empty');
      });
    });
  });
  (root||document).querySelectorAll('.report-preview').forEach(function(w){
    var inner=w.firstElementChild; if (!inner) return;
    inner.style.zoom=''; var need=640, have=w.clientWidth;
    if (have && have<need) inner.style.zoom=(have/need).toFixed(3);
  });
};
(function(){
  var queued=false;
  var run=function(){ queued=false; App.cardifyTables(document); };
  new MutationObserver(function(){ if (!queued) { queued=true; requestAnimationFrame(run); } })
    .observe(document.body, { childList:true, subtree:true });
  window.addEventListener('resize', function(){ if (!queued) { queued=true; requestAnimationFrame(run); } App.fitPrintPreview(); });
})();

window.onload = function() {
  document.getElementById('logoutBtn').onclick = function(){ App.logout(); };
  document.getElementById('logoutBtnSide').onclick = function(){ App.toggleNav(false); App.logout(); };
  document.getElementById('menuBtn').onclick = function(){ App.toggleNav(); };
  document.getElementById('navBackdrop').onclick = function(){ App.toggleNav(false); };
  document.addEventListener('keydown', function(e){ if (e.key==='Escape') App.toggleNav(false); });
  document.getElementById('changePwBtn').onclick = function(){ App.showChangePassword(); };
  document.querySelectorAll('.theme-btn').forEach(function(b){ b.onclick=function(){ App.toggleTheme(); }; });
  App.paintThemeButtons();
  // Follow the device setting until the user picks one.
  try { if (window.matchMedia) matchMedia('(prefers-color-scheme: light)').addEventListener('change', function(e){
    var saved=null; try { saved=localStorage.getItem('iss-theme'); } catch(x){}
    if (saved!=='light' && saved!=='dark') App.setTheme(e.matches?'light':'dark', false); }); } catch(e){}
  App.checkSetup();
};
