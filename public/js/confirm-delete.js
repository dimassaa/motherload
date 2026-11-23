/**
 * Progressive enhancement for destructive forms.
 *
 * A form opts in with `data-confirm="<question>"`. Without JavaScript the form
 * submits normally; with JavaScript the browser asks the native confirm dialog
 * first. The handler is centralised so every destructive form behaves the same
 * and no inline `onclick` is needed under the strict CSP.
 */
for (const form of document.querySelectorAll('form[data-confirm]')) {
  form.addEventListener('submit', (event) => {
    const question = form.dataset.confirm;
    if (question && !window.confirm(question)) {
      event.preventDefault();
    }
  });
}
