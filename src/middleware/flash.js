/**
 * One-shot flash messages on top of the session.
 *
 * Only one message is kept: the UI shows a single banner, and queuing several
 * would stack notices the user did not ask for. Reading happens during render,
 * so a refresh cannot replay the same message.
 *
 * This middleware must run after the session middleware. Before Task 4 adds
 * sessions it stays inert instead of crashing views.
 */
export function attachFlash(req, res, next) {
  const session = req.session;

  res.locals.flash = session?.flash ?? null;
  if (session?.flash) {
    delete session.flash;
  }

  // Controllers call req.flash('success', 'Приёмка проведена') before redirect.
  req.flash = (type, message) => {
    if (!req.session) return;
    req.session.flash = { type, message };
  };

  next();
}
