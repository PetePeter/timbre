export interface AddressBookContact {
  id: string;
  name: string;
  numbers: string[];
  group: string;
  trusted: boolean;
  isUser: boolean;
}

export type AddressBookContactInput = Omit<AddressBookContact, 'id'>;
