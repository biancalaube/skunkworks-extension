// Documentation: https://sdk.netlify.com/docs
import { NetlifyExtension } from "@netlify/sdk";


const extension = new NetlifyExtension();

extension.addBuildEventHandler("onPreBuild", () => {
  // If the build event handler is not enabled, return early
  if (!process.env["SKUNKWORKS_NETLIFY_EXTENSION_ENABLED"]) {
    return;
  }
  console.log("Hello there.");
});
  
export { extension };

