export const SUMMARY_NOTIFICATION_PREFERENCES = ['all', 'missed', 'handed_over', 'left_message'] as const;
export type SummaryNotificationPreference = typeof SUMMARY_NOTIFICATION_PREFERENCES[number];

export interface AddressBookContact {
  id: string;
  name: string;
  numbers: string[];
  group: string;
  trusted: boolean;
  isUser: boolean;
  /** Missing on legacy contacts; an empty list is an explicit opt-out. */
  summaryNotifications?: SummaryNotificationPreference[];
  /** Write-only credential status; PIN digits and hashes are never returned. */
  pinSet?: boolean;
  /** Set when a legacy credential was cleared because its owner was ambiguous. */
  pinNeedsReentry?: boolean;
}

export type AddressBookContactInput = Omit<AddressBookContact, 'id' | 'pinSet' | 'pinNeedsReentry'> & {
  pin?: string;
  clearPin?: boolean;
};
