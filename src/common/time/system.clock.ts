/** The production Clock. One line of behaviour, injected everywhere so the seam exists. */
import { Injectable } from '@nestjs/common';

import { BaseClock } from './clock';

@Injectable()
export class SystemClock extends BaseClock {
  nowMs(): number {
    return Date.now();
  }
}
