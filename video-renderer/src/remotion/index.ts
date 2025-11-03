import { registerRoot } from "remotion";
import { RemotionRoot } from "./root";
 
registerRoot(RemotionRoot);
 
// Lightweight debug hint to confirm root registration in headless renders
// (No functional change; helps debugging if font preloads fail)
if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-console
  console.log('Remotion root registered');
}