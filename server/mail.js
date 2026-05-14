import nodemailer from 'nodemailer';

function smtpConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS &&
      process.env.SMTP_FROM,
  );
}

/**
 * @param {string} to
 * @param {string} code
 * @returns {Promise<{ sent: boolean, devLog?: string }>}
 */
export async function sendRecoveryCode(to, code) {
  const subject = 'Luck of the Draw account recovery code';
  const text = `Your recovery code is: ${code}\n\nIt expires in 15 minutes. If you did not request this, ignore this email.`;

  if (!smtpConfigured()) {
    const line = `[Luck of the Draw] Recovery code for ${to}: ${code} (SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM to send real mail)`;
    console.log(line);
    return { sent: false, devLog: line };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    text,
  });
  return { sent: true };
}
