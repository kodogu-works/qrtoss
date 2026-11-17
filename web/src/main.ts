import { createAppPaths } from './paths';
import { startReceiver } from './receiver';
import { startSender } from './sender';
import './style.css';

const paths = createAppPaths(import.meta.env.BASE_URL);
const sender = location.pathname.replace(/\/$/, '') === paths.sender;
// Remove the capability and PSK before initialization or any asynchronous work.
let fragment = sender ? location.hash : '';
if (sender) history.replaceState(null, '', paths.sender);
if (sender) startSender(paths, fragment);
else startReceiver(paths);
fragment = '';
