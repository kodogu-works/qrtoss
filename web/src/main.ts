import { selectWebEntry } from './entry';
import { createAppPaths } from './paths';
import { startReceiver } from './receiver';
import { startSender } from './sender';
import { startSharedController } from './shared-controller';
import { classifyConnectionLink } from './shared-link';
import { startSharedReceiver } from './shared-receiver';
import './style.css';

const paths = createAppPaths(import.meta.env.BASE_URL);
const legacyReceiverHistory =
  !!history.state &&
  typeof history.state === 'object' &&
  (history.state as Record<string, unknown>).qrtossLegacyReceiver === 1;
const entry = selectWebEntry(
  location.pathname,
  location.href,
  location.origin,
  paths,
  legacyReceiverHistory,
);
// Remove capabilities and the explicit legacy selector before initialization or async work.
const connection = classifyConnectionLink(location.href, location.origin, paths);
let fragment =
  entry === 'legacy-sender' && connection.kind === 'legacy'
    ? connection.fragment
    : entry === 'shared-controller' && connection.kind === 'shared'
      ? location.hash
      : '';
if (entry === 'legacy-receiver') history.replaceState({ qrtossLegacyReceiver: 1 }, '', paths.home);
else if (entry !== 'shared-receiver') history.replaceState(null, '', paths.sender);
if (entry === 'shared-receiver') startSharedReceiver(paths);
else if (entry === 'legacy-receiver') startReceiver(paths);
else if (entry === 'legacy-sender') startSender(paths, fragment);
else startSharedController(paths, fragment);
fragment = '';
