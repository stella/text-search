import { library } from "@stll/oxlint-config";
import {
  portableSafetyPluginSpecifiers,
  portableSafetyRules,
} from "@stll/oxlint-plugin";

export default library({
  jsPlugins: portableSafetyPluginSpecifiers,
  rules: portableSafetyRules,
});
