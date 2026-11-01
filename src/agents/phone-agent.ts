/** Whatever answers a phone: receives PhoneBridge prompts, acts through the phone tools. */
export interface SmsConversationContext {
  kind: 'sms';
  senderNumber: string;
  countryCode: string;
  interactionId: string;
}

export interface PhoneAgent {
  deliver(text: string, context?: SmsConversationContext): Promise<void>;
  stop(): void | Promise<void>;
}
