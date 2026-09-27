export type LightAction =
  | 'solid'
  | 'flash'
  | 'off';

export interface LightCommand {
  type: 'command';

  action: LightAction;

  color: string;

  duration: number;

  timestamp: number;

  sequence: number;
}

export interface CommandTarget {
  zone: string | 'all';

  row?: string;
}