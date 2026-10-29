/** Whatever answers a phone: receives PhoneBridge prompts, acts through the phone tools. */
export interface PhoneAgent {
  deliver(text: string): Promise<void>;
  stop(): void | Promise<void>;
}
