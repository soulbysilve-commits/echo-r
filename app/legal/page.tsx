export default function LegalNotice() {
  return (
    <main className="min-h-screen bg-black text-gray-300 py-24 px-6 selection:bg-blue-500/30">
      <div className="mx-auto max-w-4xl">
        <a href="/" className="text-sm font-bold text-blue-400 hover:text-blue-300 mb-8 inline-block tracking-widest uppercase">
          ← Back to ECHO-R
        </a>

        <h1 className="text-4xl font-black text-white tracking-tight mb-12 md:text-5xl">
          特定商取引法に基づく表示
        </h1>

        <div className="space-y-12">
          <section>
            <h2 className="text-xl font-bold text-white mb-6 border-b border-white/10 pb-4">基本情報</h2>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 md:gap-0 border border-white/10 rounded-2xl overflow-hidden bg-white/[0.02]">
              {[
                ["販売業者", "Veritas Forge（屋号）"],
                ["運営責任者", "SoulBySilver"],
                ["所在地", "大阪府大阪市東淀川区西淡路3-9-10-804"],
                ["電話番号", "080-9033-2169（お問い合わせは原則メールにてお願いいたします）"],
                ["メールアドレス", "soulbysilver@veritasforge.net"],
                ["ウェブサイト", "https://echo-r.veritasforge.net"],
                ["販売 URL", "https://forms.gle/xgWPMKup3UvC41W1A"],
              ].map(([label, value], i) => (
                <div key={label} className={`flex flex-col md:flex-row md:items-center p-5 ${i !== 0 ? "border-t border-white/5" : ""}`}>
                  <div className="text-sm font-bold text-gray-400 md:w-1/3 mb-1 md:mb-0">{label}</div>
                  <div className="text-base text-gray-200 md:w-2/3">{value}</div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-xl font-bold text-white mb-6 border-b border-white/10 pb-4">販売条件・その他事項</h2>
            <div className="space-y-8">
              <div>
                <h3 className="text-blue-400 font-bold mb-2 tracking-widest text-sm uppercase">取扱いサービス</h3>
                <ul className="list-disc list-inside space-y-1 text-gray-400">
                  <li>AI人格アシスタント「ECHO-R」をはじめとするカスタムAIエージェントの構築・運用サポート</li>
                  <li>AI人格の記憶管理および継続運用サービス</li>
                  <li>AIコンサルティングおよび技術支援</li>
                  <li>研究開発・プロトコル設計支援</li>
                </ul>
                <p className="mt-2 text-sm text-gray-500">※物理商品の販売は行っておりません。</p>
              </div>

              <div>
                <h3 className="text-blue-400 font-bold mb-2 tracking-widest text-sm uppercase">販売価格</h3>
                <p className="text-white font-bold mb-2">ECHO-R Founder Edition</p>
                <ul className="list-disc list-inside space-y-1 text-gray-400">
                  <li>初期導入費（Activation Fee）：500,000円（税込）</li>
                  <li>月額プロトコル費：450,000円（税込）／月</li>
                  <li>Discord等の初期セットアップ（任意）：150,000円（税込）</li>
                </ul>
                <p className="mt-2 text-sm text-gray-500">※価格は契約時の見積書および契約書を優先します。</p>
              </div>

              <div>
                <h3 className="text-blue-400 font-bold mb-2 tracking-widest text-sm uppercase">商品代金以外の必要料金</h3>
                <ul className="list-disc list-inside space-y-1 text-gray-400">
                  <li>銀行振込手数料</li>
                  <li>クレジットカード決済手数料（カード会社規定による）</li>
                  <li>通信費・インターネット接続費用</li>
                </ul>
              </div>

              <div>
                <h3 className="text-blue-400 font-bold mb-2 tracking-widest text-sm uppercase">申込の有効期限</h3>
                <p className="text-gray-400">応募フォーム送信後、原則3営業日以内に受付確認メールを送信します。<br />募集枠が満了した場合は受付を終了する場合があります。</p>
              </div>

              <div>
                <h3 className="text-blue-400 font-bold mb-2 tracking-widest text-sm uppercase">サービス提供開始時期</h3>
                <p className="text-gray-400">初期費用の入金確認後に設計・構築を開始します。<br />提供開始日は双方協議のうえ決定します。</p>
              </div>

              <div>
                <h3 className="text-blue-400 font-bold mb-2 tracking-widest text-sm uppercase">お支払い方法</h3>
                <ul className="list-disc list-inside space-y-1 text-gray-400">
                  <li>Stripeによるクレジットカード決済</li>
                  <li>銀行振込</li>
                </ul>
              </div>

              <div>
                <h3 className="text-blue-400 font-bold mb-2 tracking-widest text-sm uppercase">お支払い時期</h3>
                <ul className="list-disc list-inside space-y-1 text-gray-400">
                  <li>初期費用：請求書発行後7日以内</li>
                  <li>月額料金：契約時に定める決済日に自動決済</li>
                </ul>
              </div>

              <div>
                <h3 className="text-blue-400 font-bold mb-2 tracking-widest text-sm uppercase">キャンセル・返金</h3>
                <ul className="list-disc list-inside space-y-1 text-gray-400">
                  <li>初期費用入金前：キャンセル可能</li>
                  <li>初期費用入金後：原則返金不可</li>
                  <li>月額料金：当月分の返金は行いません</li>
                </ul>
              </div>

              <div>
                <h3 className="text-blue-400 font-bold mb-2 tracking-widest text-sm uppercase">中途解約</h3>
                <p className="text-gray-400">最低契約期間：12ヶ月<br />解約希望の場合は契約終了希望日の10日前までにメールにて通知してください。<br />解約後のデータ・ログ・成果物の扱いは契約書に従います。</p>
              </div>

              <div>
                <h3 className="text-blue-400 font-bold mb-2 tracking-widest text-sm uppercase">動作環境</h3>
                <ul className="list-disc list-inside space-y-1 text-gray-400">
                  <li>インターネット接続環境</li>
                  <li>Google Chrome / Microsoft Edge / Safari 最新版</li>
                  <li>Discord / Zoom / Google Meet 等</li>
                </ul>
              </div>

              <div>
                <h3 className="text-blue-400 font-bold mb-2 tracking-widest text-sm uppercase">Founder Editionに関する特別条件</h3>
                <ul className="list-disc list-inside space-y-1 text-gray-400">
                  <li>Founder Editionは最大5インスタンス限定です。</li>
                  <li>応募内容・利用目的・適合性を審査したうえで提供可否を決定します。</li>
                  <li>当社判断により申込をお断りする場合があります。</li>
                </ul>
              </div>

              <div>
                <h3 className="text-blue-400 font-bold mb-2 tracking-widest text-sm uppercase">クーリングオフ</h3>
                <p className="text-gray-400">本サービスは主として法人・個人事業主・研究者向けの役務提供サービスであり、クーリングオフ制度の適用対象外となる場合があります。</p>
              </div>

              <div>
                <h3 className="text-blue-400 font-bold mb-2 tracking-widest text-sm uppercase">免責事項</h3>
                <ul className="list-disc list-inside space-y-1 text-gray-400">
                  <li>ECHO-Rは成果や売上を保証するものではありません。</li>
                  <li>AIの出力内容については利用者自身の責任で確認・判断してください。</li>
                  <li>利用者の運用・指示に起因する損害について当社は責任を負いません。</li>
                </ul>
              </div>

              <div>
                <h3 className="text-blue-400 font-bold mb-2 tracking-widest text-sm uppercase">お問い合わせ窓口</h3>
                <p className="text-gray-400">メール：soulbysilver@veritasforge.net<br />電話：080-9033-2169<br />受付時間：平日 10:00〜18:00（日本時間）</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}