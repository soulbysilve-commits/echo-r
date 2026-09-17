import EchoAgentProduct, { echoAgentMetadata } from "../../components/EchoAgentProduct";

export const metadata = echoAgentMetadata("ja");

export default function Page() {
  return <EchoAgentProduct locale="ja" />;
}
