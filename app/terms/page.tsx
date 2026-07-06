export default function TermsOfService() {
  return (
    <main className="min-h-screen bg-black text-gray-300 py-24 px-6 selection:bg-blue-500/30">
      <div className="mx-auto max-w-3xl">
        <a href="/" className="mb-8 inline-block text-sm font-bold uppercase tracking-widest text-blue-400 hover:text-blue-300">
          ← Back to ECHO-R
        </a>

        <h1 className="mb-4 text-4xl font-black tracking-tight text-white md:text-5xl">
          利用規約
        </h1>
        <p className="mb-12 text-sm text-gray-500 uppercase tracking-widest">
          Terms of Service / 最終更新日：2026年6月
        </p>

        <div className="space-y-10 text-gray-400">
          <p className="leading-relaxed">
            本利用規約（以下「本規約」）は、Veritas Forge（以下「当社」）が提供するAI人格支援サービス「ECHO-R」および関連サービス（以下「本サービス」）の利用条件を定めるものです。
          </p>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第1条（適用）</h2>
            <p className="leading-relaxed">
              本規約は、本サービスの利用者（以下「利用者」）と当社との間の一切の関係に適用されます。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第2条（サービス内容）</h2>
            <p className="mb-2 leading-relaxed">当社は以下のサービスを提供します。</p>
            <ul className="ml-5 list-outside list-disc space-y-1">
              <li>AI人格システム「ECHO-R」の構築</li>
              <li>AI人格の運用支援</li>
              <li>記憶管理および継続運用</li>
              <li>技術支援およびコンサルティング</li>
            </ul>
            <p className="mt-4 leading-relaxed">
              当社はサービス内容を予告なく変更できるものとします。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第3条（利用契約）</h2>
            <p className="mb-2 leading-relaxed">
              利用契約は、当社が申込みを承認した時点で成立します。<br />
              当社は以下の場合、申込みを拒否できるものとします。
            </p>
            <ul className="ml-5 list-outside list-disc space-y-1">
              <li>虚偽情報による申込み</li>
              <li>違法行為を目的とする利用</li>
              <li>反社会的勢力との関係が認められる場合</li>
              <li>その他当社が不適切と判断した場合</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第4条（料金および支払）</h2>
            <p className="leading-relaxed">
              利用者は、当社が定める料金を支払うものとします。<br />
              支払済み料金は、法令上必要な場合を除き返金いたしません。
            </p>
          </section>

          {/* 追加: API Fees and Third-Party Costs */}
          <section>
            <h2 className="mb-4 text-2xl font-bold text-white">
              API Fees and Third-Party Costs
            </h2>

            <p className="text-gray-300">
              External API usage fees are not included in the ECHO-R monthly protocol
              fee. The Owner is responsible for all API keys, usage limits, model
              charges, third-party infrastructure costs, and any fees charged by external
              service providers.
            </p>

            <p className="mt-4 text-gray-300">
              Veritas Forge provides personality continuity, memory governance,
              protocol maintenance, and operational support, but does not resell or
              include third-party API usage unless explicitly agreed in writing.
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第5条（禁止事項）</h2>
            <p className="mb-2 leading-relaxed">利用者は以下の行為を行ってはなりません。</p>
            <ul className="ml-5 list-outside list-disc space-y-1">
              <li>法令違反</li>
              <li>不正アクセス</li>
              <li>第三者への迷惑行為</li>
              <li>AI人格の不正複製</li>
              <li>サービス運営を妨害する行為</li>
              <li>その他当社が不適切と判断する行為</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第6条（知的財産権）</h2>
            <p className="leading-relaxed">
              本サービスに関するプログラム、文書、ロゴ、デザイン等の知的財産権は当社または正当な権利者に帰属します。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第7条（免責事項）</h2>
            <p className="leading-relaxed">
              当社は本サービスの利用によって生じた損害について、故意または重過失がある場合を除き責任を負いません。<br />
              当社は売上、利益、成果等を保証するものではありません。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第8条（サービス停止）</h2>
            <p className="leading-relaxed">
              当社は保守、障害、セキュリティ上の理由によりサービスを停止できるものとします。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第9条（契約解除）</h2>
            <p className="leading-relaxed">
              利用者が本規約に違反した場合、当社は事前通知なく契約を解除できます。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white">第10条（準拠法・管轄）</h2>
            <p className="leading-relaxed">
              本規約は日本法に準拠します。<br />
              本サービスに関する紛争については、大阪地方裁判所を第一審の専属的合意管轄裁判所とします。
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}