/**
 * Email delivery.
 *
 * Three drivers: `smtp` (production), `console` (development — logs the message
 * so flows are testable without a mail server) and `none` (disabled). The
 * interface is intentionally narrow: only transactional templates Zyvano sends.
 */
import nodemailer, { type Transporter } from 'nodemailer';

import type { AppConfig } from '../../config/env';
import { logger } from '../../observability/logger';

export interface Mailer {
  readonly driver: 'smtp' | 'console' | 'none';
  sendEmailVerification(input: { to: string; displayName: string; verifyUrl: string }): Promise<void>;
  sendPasswordReset(input: { to: string; displayName: string; resetUrl: string }): Promise<void>;
  sendOrganizationInvite(input: {
    to: string;
    organizationName: string;
    inviterName: string;
    acceptUrl: string;
  }): Promise<void>;
  sendNotification(input: { to: string; subject: string; body: string }): Promise<void>;
  verify(): Promise<boolean>;
}

function wrap(title: string, body: string, cta?: { label: string; url: string }): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#0b0d12;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#e7e9ee">
  <div style="max-width:560px;margin:0 auto;background:#141821;border:1px solid #232a38;border-radius:14px;padding:32px">
    <h1 style="margin:0 0 16px;font-size:20px">${title}</h1>
    <div style="font-size:15px;line-height:1.6;color:#b9c0cf">${body}</div>
    ${
      cta
        ? `<p style="margin:28px 0 0"><a href="${cta.url}" style="display:inline-block;background:#6d5efc;color:#fff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:600">${cta.label}</a></p>
           <p style="margin:16px 0 0;font-size:12px;color:#7d8697">If the button does not work, copy this link:<br>${cta.url}</p>`
        : ''
    }
  </div>
</body></html>`;
}

class ConsoleMailer implements Mailer {
  readonly driver = 'console' as const;

  private log(subject: string, to: string, html: string): void {
    logger.info({ to, subject, preview: html.slice(0, 200) }, 'email (console driver)');
  }

  async sendEmailVerification(input: { to: string; displayName: string; verifyUrl: string }): Promise<void> {
    this.log(
      'Verify your Zyvano email',
      input.to,
      wrap('Confirm your email', `Hi ${input.displayName}, confirm your Zyvano account.`, {
        label: 'Verify email',
        url: input.verifyUrl,
      }),
    );
  }

  async sendPasswordReset(input: { to: string; displayName: string; resetUrl: string }): Promise<void> {
    this.log(
      'Reset your Zyvano password',
      input.to,
      wrap('Reset your password', `Hi ${input.displayName}, choose a new password.`, {
        label: 'Reset password',
        url: input.resetUrl,
      }),
    );
  }

  async sendOrganizationInvite(input: {
    to: string;
    organizationName: string;
    inviterName: string;
    acceptUrl: string;
  }): Promise<void> {
    this.log(
      `You have been invited to ${input.organizationName} on Zyvano`,
      input.to,
      wrap(
        'You have an invitation',
        `${input.inviterName} invited you to collaborate in ${input.organizationName}.`,
        { label: 'Accept invitation', url: input.acceptUrl },
      ),
    );
  }

  async sendNotification(input: { to: string; subject: string; body: string }): Promise<void> {
    this.log(input.subject, input.to, wrap(input.subject, input.body));
  }

  async verify(): Promise<boolean> {
    return true;
  }
}

class NoopMailer implements Mailer {
  readonly driver = 'none' as const;
  async sendEmailVerification(): Promise<void> {}
  async sendPasswordReset(): Promise<void> {}
  async sendOrganizationInvite(): Promise<void> {}
  async sendNotification(): Promise<void> {}
  async verify(): Promise<boolean> {
    return true;
  }
}

class SmtpMailer implements Mailer {
  readonly driver = 'smtp' as const;
  private readonly transport: Transporter;

  constructor(
    private readonly from: string,
    config: AppConfig['email'],
  ) {
    this.transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      ...(config.smtpUser
        ? { auth: { user: config.smtpUser, pass: config.smtpPassword as string } }
        : {}),
    });
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, subject, html });
  }

  async sendEmailVerification(input: { to: string; displayName: string; verifyUrl: string }): Promise<void> {
    await this.send(
      input.to,
      'Verify your Zyvano email',
      wrap('Confirm your email', `Hi ${input.displayName}, confirm your Zyvano account.`, {
        label: 'Verify email',
        url: input.verifyUrl,
      }),
    );
  }

  async sendPasswordReset(input: { to: string; displayName: string; resetUrl: string }): Promise<void> {
    await this.send(
      input.to,
      'Reset your Zyvano password',
      wrap('Reset your password', `Hi ${input.displayName}, choose a new password.`, {
        label: 'Reset password',
        url: input.resetUrl,
      }),
    );
  }

  async sendOrganizationInvite(input: {
    to: string;
    organizationName: string;
    inviterName: string;
    acceptUrl: string;
  }): Promise<void> {
    await this.send(
      input.to,
      `You have been invited to ${input.organizationName} on Zyvano`,
      wrap(
        'You have an invitation',
        `${input.inviterName} invited you to collaborate in ${input.organizationName}.`,
        { label: 'Accept invitation', url: input.acceptUrl },
      ),
    );
  }

  async sendNotification(input: { to: string; subject: string; body: string }): Promise<void> {
    await this.send(input.to, input.subject, wrap(input.subject, input.body));
  }

  async verify(): Promise<boolean> {
    try {
      await this.transport.verify();
      return true;
    } catch (error) {
      logger.error({ err: error }, 'smtp verification failed');
      return false;
    }
  }
}

export function createMailer(config: AppConfig['email']): Mailer {
  if (config.driver === 'smtp') return new SmtpMailer(config.from, config);
  if (config.driver === 'none') return new NoopMailer();
  return new ConsoleMailer();
}
