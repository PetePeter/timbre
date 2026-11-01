/** Whatever answers a phone: receives PhoneBridge prompts, acts through the phone tools. */
export interface SmsConversationContext {
  kind: 'sms';
  senderNumber: string;
  countryCode: string;
  interactionId: string;
  /** Verified out of band; never includes the PIN or its hash. */
  actionAuthorization?: { allowed: boolean; refusal: string };
  actionAuthorizationExpiresAt?: number;
}

export interface PhoneAgent {
  deliver(text: string, context?: SmsConversationContext): Promise<void>;
  stop(): void | Promise<void>;
}
