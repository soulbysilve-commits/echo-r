import LanguageSwitch from "../components/LanguageSwitch";

export default function EchoAgentEula() {
  return (
    <main className="min-h-screen bg-black text-gray-300 py-24 px-6 selection:bg-blue-500/30">
      <LanguageSwitch current="en" enHref="/eula" jaHref="/ja/eula" />
      <div className="mx-auto max-w-3xl">
        <a href="/echo-agent" className="mb-8 inline-block text-sm font-bold uppercase tracking-widest text-blue-400 hover:text-blue-300">
          ← Back to ECHO Agent
        </a>

        <h1 className="mb-4 text-4xl font-black tracking-tight text-white md:text-5xl">
          ECHO Agent 使用許諾契約書（EULA）
        </h1>
        <p className="mb-6 text-sm text-gray-500 uppercase tracking-widest">
          End User License Agreement / 最終更新日：2026年9月
        </p>

        <div className="mb-12 rounded-2xl border border-yellow-500/30 bg-yellow-500/[0.06] p-5 text-sm leading-7 text-yellow-200">
          <p className="font-bold text-yellow-100">
            DRAFT — 本契約書は法務レビューを経ていない草案です。
          </p>
          <p className="mt-2">
            正式なライセンス条件として確定する前に、専門家によるレビューを予定しています。本ページの内容は現時点の実装・運用方針に基づいて作成されていますが、将来変更される可能性があります。
          </p>
        </div>

        <div className="space-y-10 text-gray-400">
          <p className="leading-relaxed">
            本契約は、Veritas Forge（屋号／運営責任者：鈴木佑人〈SoulBySilver〉、以下「当社」）が提供する「ECHO Agent」（以下「本ソフトウェア」）の使用条件を定めるものです。本ソフトウェアの購入・インストール・使用により、利用者は本契約に同意したものとみなされます。
          </p>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第1条（ライセンスの許諾）</h2>
            <p className="leading-relaxed">
              当社は、有効なECHO Agentサブスクリプションを条件として、利用者に対し、本ソフトウェアのコンパイル済みWindows配布物を1台の端末にインストールし、利用者自身の目的のために使用する、個人的・非独占的・譲渡不能・再許諾不能なライセンスを許諾します。本ライセンスはソースコードへのいかなる権利も付与しません。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第2条（サブスクリプションとの関係）</h2>
            <p className="leading-relaxed">
              ECHO Agentは月額3,000円（消費税：免税事業者、適格請求書発行事業者登録：未登録）のサブスクリプションとして、Stripe決済により提供されます。決済確認後、署名付きライセンスとダウンロード権限が自動的に発行されます。ライセンスは発行時点から1年間有効な期限付き資格情報であり、サブスクリプションとは独立した有効期限を持ちます（第9条参照）。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第3条（許諾される利用）</h2>
            <ul className="ml-5 list-outside list-disc space-y-1">
              <li>自己の正当な目的のための本ソフトウェアのインストールおよび実行</li>
              <li>承認したWindows操作についてのみ、承認ゲート付きComputer Use機能を利用すること</li>
              <li>利用者が別途契約するローカルまたは第三者のLLM/APIプロバイダの利用（第6条）</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第4条（知的財産権）</h2>
            <p className="leading-relaxed">
              本ソフトウェア、コンパイル済みコア、関連文書および知的財産権は当社またはその許諾者に帰属します。第1条に定める限定的ライセンスを除き、いかなる権利も移転されません。利用者は、本ソフトウェアを用いて作成した自己のデータ・ファイル・成果物の権利を保持します。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第5条（アップデート）</h2>
            <p className="leading-relaxed">
              開発者向け限定提供の現段階では、アップデートの提供時期・頻度・互換性は契約上保証されません。アップデートを提供する場合は、事前に変更内容とバックアップの要否を案内します。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第6条（第三者コンポーネント／API・プロバイダの責任）</h2>
            <p className="leading-relaxed">
              本ソフトウェアはローカルモデル（Ollama等）または利用者が別途設定する第三者API型モデルを利用する場合があります。これらの取得・利用料金・利用条件の遵守は利用者の責任です。本サブスクリプション料金には第三者モデル・API利用料は含まれません。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第7条（ローカル実行）</h2>
            <p className="leading-relaxed">
              本ソフトウェアは利用者自身のWindows端末上でのローカル実行を基本とします。ただし、モデルの取得・更新、ライセンス確認、アップデート確認等のために通信が必要となる場合があります。ローカル実行であることは、通信が一切不要であることを意味しません。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第8条（Agentの外部操作・承認・認証情報の責任）</h2>
            <p className="leading-relaxed">
              本ソフトウェアは承認境界を通じて、利用者のWindows端末上で実際の操作を行うことができます。利用者は、承認ゲートで求められる各操作を確認・承認する責任、本ソフトウェアに与えるアクセス権・認証情報の管理責任、および重要なデータについて操作前にバックアップを取る責任を負います。承認は操作の安全性を保証するものではありません。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第9条（解約が及ぼす範囲・及ぼさない範囲）</h2>
            <p className="mb-2 leading-relaxed">実装済みの挙動を、正確に記載します。</p>
            <ul className="ml-5 list-outside list-disc space-y-1">
              <li>解約により、以後の課金は停止します（現在の支払期間終了時に有効）。</li>
              <li>解約後は、新たなライセンス・ダウンロードの発行は行われません。</li>
              <li>
                解約は、解約前に既に発行されたライセンス・ダウンロード済みの本体を無効化・取消しするものではありません。発行済みライセンスは、その発行時に設定された有効期限（現在の実装では発行から1年間）まで、サブスクリプションの状態にかかわらず有効です。これは現時点の技術的な制約であり、将来変更される可能性があります。
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第10条（禁止事項）</h2>
            <ul className="ml-5 list-outside list-disc space-y-1">
              <li>適用法で許容される範囲を超えるリバースエンジニアリング</li>
              <li>コンパイル済みコア、発行済みライセンス・ダウンロードの再配布・転売・再許諾</li>
              <li>承認ゲート付き自動操作を用いた、無許可・違法・有害な操作の実行</li>
              <li>ライセンス・資格情報・ダウンロード認可の仕組みを回避する試み</li>
              <li>Stripeに紐づく資格情報・ライセンス・ダウンロード権限を第三者と共有すること</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第11条（解約・返金）</h2>
            <p className="leading-relaxed">
              いつでも解約可能です。解約は現在の支払期間終了時に有効となり、解約手数料はかかりません。最低契約期間はありません。<br />
              提供済み（ライセンス発行済み）のデジタル商品は原則として返金いたしません。ただし、二重課金、明確な請求誤り、当社の提供不履行、当社の責に帰すべき破損・利用不能な場合、または法令上必要な場合は返金いたします。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第12条（開発者向け限定提供／ベータ段階であることの明示）</h2>
            <p className="leading-relaxed">
              ECHO Agentは「開発者向け限定提供（Developer Limited Release）」段階で提供されます。対応OSはWindowsのみであり、SLA・サポート対応時間・アップデート頻度は保証されません。この位置づけは価格や課金義務を減免するものではありません。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第13条（契約終了）</h2>
            <p className="leading-relaxed">
              当社は、第10条違反または未払いの場合、ライセンスを終了できます。利用者はいつでも第11条に従いサブスクリプションを解約することで契約を終了できます。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第14条（保証の否認）</h2>
            <p className="leading-relaxed">
              本ソフトウェアは開発者向け限定提供段階のものであり、「現状有姿」「提供可能な範囲」で提供され、商品性・特定目的適合性・権利非侵害を含め、明示・黙示を問わずいかなる保証もいたしません（適用法上排除できない権利を除きます）。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第15条（責任の制限）</h2>
            <p className="leading-relaxed">
              適用法上許容される最大限度において、当社の責任は、請求の原因となった事由の発生前3か月間に利用者が実際に支払ったサブスクリプション料金の総額を上限とします。当社は、承認済みWindows操作に起因する損害を含め、間接的・付随的・結果的損害について責任を負いません。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第16条（準拠法・管轄）</h2>
            <p className="leading-relaxed">
              本契約は日本法に準拠するものとし、大阪地方裁判所を第一審の専属的合意管轄裁判所とすることを想定しています（法務レビューにより確定前）。
            </p>
          </section>

          <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 text-sm">
            <p className="font-bold text-white mb-2">Veritas Forge</p>
            <p>Email: <a href="mailto:soulbysilver@veritasforge.net" className="text-blue-400 hover:underline">soulbysilver@veritasforge.net</a></p>
          </section>
        </div>
      </div>
    </main>
  );
}
