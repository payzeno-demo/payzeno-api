/**
 * The one email layout. Every template is content — a heading, some paragraphs, an optional
 * key/value block and an optional button — and this file turns that into the HTML part and the
 * plain-text part of the same message.
 *
 * Inline styles and a table layout on purpose: mail clients ignore `<style>` blocks and most of
 * CSS, and the plain-text part is not an afterthought — Mailpit's API, the sim-world bots and a
 * good share of real inboxes read nothing else. Everything interpolated into the HTML goes
 * through `escapeHtml`; template data is merchant- and shopper-controlled text.
 */

/** What a template produces. Rendering never fails on missing data — a blank stays blank. */
export interface EmailContent {
  subject: string;
  heading: string;
  paragraphs: string[];
  /** Rendered as a two-column block. Rows whose value is blank are dropped. */
  details?: Array<[label: string, value: string]>;
  /** The link the email exists to deliver. Omitted when the url is blank. */
  action?: { label: string; url: string };
  /** Small print under the button: expiry, "you can ignore this", who to contact. */
  footnote?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const BRAND = 'Payzeno';
const ACCENT = '#4338ca';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) links become buttons. A `javascript:` url from template data is dropped. */
function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

export function renderLayout(content: EmailContent): RenderedEmail {
  const details = (content.details ?? []).filter(([, value]) => value.trim() !== '');
  const actionUrl = content.action ? safeUrl(content.action.url) : null;

  return {
    subject: content.subject.replace(/\s+/g, ' ').trim(),
    html: renderHtml(content, details, actionUrl),
    text: renderText(content, details, actionUrl),
  };
}

function renderHtml(
  content: EmailContent,
  details: Array<[string, string]>,
  actionUrl: string | null,
): string {
  const paragraphs = content.paragraphs
    .filter((p) => p.trim() !== '')
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:22px;color:#1f2937;">${escapeHtml(p)}</p>`)
    .join('\n');

  const detailRows = details
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 16px 6px 0;font-size:13px;color:#6b7280;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>` +
        `<td style="padding:6px 0;font-size:14px;color:#111827;">${escapeHtml(value)}</td></tr>`,
    )
    .join('\n');
  const detailBlock = detailRows
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;width:100%;">${detailRows}</table>`
    : '';

  const button =
    content.action && actionUrl
      ? `<p style="margin:8px 0 24px;"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:${ACCENT};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">${escapeHtml(content.action.label)}</a></p>` +
        `<p style="margin:0 0 16px;font-size:12px;line-height:18px;color:#6b7280;">Or paste this link into your browser:<br><a href="${escapeHtml(actionUrl)}" style="color:${ACCENT};word-break:break-all;">${escapeHtml(actionUrl)}</a></p>`
      : '';

  const footnote = content.footnote
    ? `<p style="margin:0;font-size:12px;line-height:18px;color:#6b7280;">${escapeHtml(content.footnote)}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(content.subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="padding:0 0 16px;font-size:20px;font-weight:700;color:${ACCENT};letter-spacing:-0.02em;">${BRAND}</td></tr>
<tr><td style="background:#ffffff;border-radius:8px;padding:32px;">
<h1 style="margin:0 0 20px;font-size:22px;line-height:28px;color:#111827;">${escapeHtml(content.heading)}</h1>
${paragraphs}
${detailBlock}
${button}
${footnote}
</td></tr>
<tr><td style="padding:16px 0 0;font-size:12px;line-height:18px;color:#9ca3af;">${BRAND} · Payments infrastructure for internet businesses. This is an automated message; replies are not monitored.</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function renderText(
  content: EmailContent,
  details: Array<[string, string]>,
  actionUrl: string | null,
): string {
  const lines: string[] = [content.heading, ''];

  for (const paragraph of content.paragraphs) {
    if (paragraph.trim() === '') continue;
    lines.push(paragraph, '');
  }
  if (details.length > 0) {
    for (const [label, value] of details) lines.push(`${label}: ${value}`);
    lines.push('');
  }
  if (content.action && actionUrl) {
    lines.push(`${content.action.label}: ${actionUrl}`, '');
  }
  if (content.footnote) {
    lines.push(content.footnote, '');
  }
  lines.push('--', `${BRAND} · This is an automated message; replies are not monitored.`);

  return `${lines.join('\n')}\n`;
}
