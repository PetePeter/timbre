export interface AddressBookContact {
  id: string;
  name: string;
  numbers: string[];
  group: string;
  trusted: boolean;
  isUser: boolean;
  /** Write-only credential status; PIN digits and hashes are never returned. */
  pinSet?: boolean;
  /** Set when a legacy credential was cleared because its owner was ambiguous. */
  pinNeedsReentry?: boolean;
}

export type AddressBookContactInput = Omit<AddressBookContact, 'id' | 'pinSet' | 'pinNeedsReentry'> & {
  pin?: string;
  clearPin?: boolean;
};
