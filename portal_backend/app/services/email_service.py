"""
email_service.py — Email alerts for stage changes.

WHY THIS EXISTS:
When InBody staff updates an order stage in Odoo (e.g. marks as Dispatched),
the customer (CultFit) should receive an email automatically.

HOW IT WORKS:
1. Odoo stage change triggers a webhook POST to FastAPI /webhooks/stage-change
2. FastAPI calls send_stage_change_alert() here
3. Email is sent to the customer's email address

For now, uses Python's built-in smtplib (no external email service needed).
Later: replace with SendGrid, Mailgun, or Amazon SES for production scale.
"""

import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# Stage labels for email readability
STAGE_LABELS = {
    "stage_1_order_received":       "Order Received",
    "stage_2_pi_issued":            "Proforma Invoice Issued",
    "stage_3_po_received":          "Purchase Order Received",
    "stage_4_md_approved":          "MD Approval Completed",
    "stage_5_dispatched":           "Order Dispatched",
    "stage_6_installation_confirmed": "Installation Confirmed",
    "stage_7_vendor_uploaded":      "Vendor Portal Uploaded",
    "stage_8_confirmation_sent":    "Confirmation Mail Sent",
    "stage_9_payment_collected":    "Payment Collected",
}


def _build_email_html(order_name: str, centre: str, stage_key: str) -> str:
    """Builds the HTML body of the stage change email."""
    stage_label = STAGE_LABELS.get(stage_key, stage_key.replace("_", " ").title())
    return f"""
    <html><body style="font-family: Arial, sans-serif; color: #333;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #6C3483;">InBody India — Order Update</h2>
            <p>Your order status has been updated.</p>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr style="background: #F4ECF7;">
                    <td style="padding: 12px; border: 1px solid #ddd;"><b>Order</b></td>
                    <td style="padding: 12px; border: 1px solid #ddd;">{order_name}</td>
                </tr>
                <tr>
                    <td style="padding: 12px; border: 1px solid #ddd;"><b>Centre</b></td>
                    <td style="padding: 12px; border: 1px solid #ddd;">{centre or '—'}</td>
                </tr>
                <tr style="background: #F4ECF7;">
                    <td style="padding: 12px; border: 1px solid #ddd;"><b>New Status</b></td>
                    <td style="padding: 12px; border: 1px solid #ddd;">
                        <span style="color: #1A5276; font-weight: bold;">✓ {stage_label}</span>
                    </td>
                </tr>
            </table>
            <p>Log in to your portal to view full order details and timeline.</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
            <p style="font-size: 12px; color: #888;">InBody India | This is an automated notification.</p>
        </div>
    </body></html>
    """


async def send_stage_change_alert(
    to_email: str,
    order_name: str,
    centre: str,
    new_stage: str,
) -> bool:
    """
    Sends a stage change notification email to the customer.
    Returns True on success, False on failure (non-blocking — email failures
    should not break the main API flow).
    """
    if not settings.SMTP_USER or not settings.SMTP_PASSWORD:
        logger.warning("SMTP not configured — skipping email alert for %s", order_name)
        return False

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"Order Update: {order_name} — {STAGE_LABELS.get(new_stage, new_stage)}"
        msg["From"] = settings.ALERT_FROM_EMAIL
        msg["To"] = to_email

        html_body = _build_email_html(order_name, centre, new_stage)
        msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as smtp:
            smtp.starttls()
            smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            smtp.sendmail(settings.ALERT_FROM_EMAIL, to_email, msg.as_string())

        logger.info("Stage alert sent to %s for order %s → %s", to_email, order_name, new_stage)
        return True

    except Exception as e:
        logger.error("Failed to send stage alert to %s: %s", to_email, str(e))
        return False
