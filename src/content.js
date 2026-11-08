// Agent Flight Recorder — form activity observer.
//
// PRIVACY BY DESIGN: this script NEVER reads field values, names, or page
// content. It only counts how many distinct fields inside each form received
// input, and reports form submissions. It is registered dynamically by the
// background worker ONLY while the user-granted optional all-sites
// permission is present — it is not declared in the manifest, so the
// extension has zero site access at install time. Reports are only recorded
// while a watch session is armed.

(function () {
  if (window.__afrFormObserver) return;
  window.__afrFormObserver = true;

  const touched = new Map(); // form element -> Set of field elements
  let reportTimer = null;

  function formIndex(form) {
    return Array.prototype.indexOf.call(document.forms, form);
  }

  function send(kind, form, fields) {
    try {
      chrome.runtime.sendMessage({
        kind,
        host: location.host,
        formIndex: form ? formIndex(form) : 0,
        fields: fields || 0,
      });
    } catch {
      /* extension context may be invalid after an update — stay silent */
    }
  }

  function flushReports() {
    reportTimer = null;
    for (const [form, fields] of touched) {
      if (fields.size > 0) send('AFR_FORM_FILL', form, fields.size);
    }
  }

  function scheduleReport() {
    if (reportTimer) return;
    reportTimer = setTimeout(flushReports, 1500);
  }

  function onFieldEvent(event) {
    const el = event.target;
    if (!el || !(el instanceof Element)) return;
    const form = el.form || el.closest('form');
    if (!form) return;
    if (!touched.has(form)) touched.set(form, new Set());
    const set = touched.get(form);
    const before = set.size;
    set.add(el);
    if (set.size !== before) scheduleReport();
  }

  document.addEventListener('input', onFieldEvent, true);
  document.addEventListener('change', onFieldEvent, true);

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const set = touched.get(form);
    if (set && set.size > 0) send('AFR_FORM_FILL', form, set.size);
    send('AFR_FORM_SUBMIT', form, set ? set.size : 0);
  }, true);

  window.addEventListener('pagehide', flushReports);
})();
