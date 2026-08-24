declare module "nodemailer" {
  interface SendMailResult {
    messageId?: string;
  }

  interface Transport {
    sendMail(message: Record<string, unknown>): Promise<SendMailResult>;
    close(): void;
  }

  const nodemailer: {
    createTransport(options: Record<string, unknown>): Transport;
  };

  export default nodemailer;
}
