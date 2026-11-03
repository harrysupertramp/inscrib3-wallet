export type PopupRequest =
  | { type: 'connect'; origin: string }
  | { type: 'send'; origin: string; address: string; amount: number };
