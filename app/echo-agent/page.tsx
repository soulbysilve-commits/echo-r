import EchoAgentProduct, { echoAgentMetadata } from "../components/EchoAgentProduct";

export const metadata = echoAgentMetadata("en");

export default function Page() {
  return <EchoAgentProduct locale="en" />;
}
