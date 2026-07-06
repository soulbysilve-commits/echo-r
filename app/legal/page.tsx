export default function LegalNotice() {
  return (
    <main className="min-h-screen bg-black px-6 py-32 text-white">
      <section className="mx-auto max-w-5xl">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          LEGAL NOTICE
        </p>

        <h1 className="text-4xl font-black tracking-tight md:text-6xl">
          特定商取引法に基づく表示
        </h1>

        <p className="mt-4 text-gray-400">
          Veritas Forge
        </p>

        <div className="mt-12 space-y-12 text-gray-300">
          <section>
            <h2 className="mb-6 text-2xl font-bold text-white">基本情報</h2>

            <div className="overflow-hidden rounded-2xl border border-white/10">
              <table className="w-full border-collapse text-left text-sm md:text-base">
                <tbody>
                  {[
                    ["販売業者", "Veritas Forge（屋号）"],
                    ["運営責任者", "鈴木佑人（SoulBySilver）"],
                    [
                      "所在地",
                      "533-0031 大阪府大阪市東淀川区西淡路3-9-10-804",
                    ],
                    [
                      "電話番号",
                      "080-9033-2169 ※お問い合わせは原則メールにてお願いいたします。",
                    ],
                    ["メールアドレス", "soulbysilver@veritasforge.net"],
                    ["ウェブサイト", "https://echo-r.veritasforge.net"],
                    ["販売URL", "https://forms.gle/xgWPMKup3UvC41W1A"],
                  ].map(([label, value]) => (
                    <tr key={label} className="border-b border-white/10">
                      <th className="w-1/3 bg-white/[0.04] px-5 py-4 font-bold text-white">
                        {label}
                      </th>
                      <td className="px-5 py-4">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-bold text-white">
              取扱いサービス
            </h2>

            <ul className="list-disc space-y-3 pl-6">
              <li>
                AI人格アシスタント「ECHO-R」をはじめとするカスタムAIエージェントの構築・運用サポートサービス
              </li>
              <li>上記サービスの月額利用料・メンテナンス費用</li>
              <li>その他、AIコンサルティング・技術サポート等の役務提供</li>
            </ul>

            <p className="mt-4 text-sm text-gray-500">
              ※物理商品の販売や投機商品・金融商品の販売は行っておりません。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-bold text-white">販売価格</h2>

            <div className="space-y-6">
              <div className="rounded-2xl border border-white/10 p-6">
                <h3 className="font-bold text-white">
                  ECHO-R Founder Entry（創世ユニット）
                </h3>
                <p className="mt-2">
                  最低入札価格：500,000円（税込）〜
                </p>
                <p className="mt-2 text-gray-400">
                  実際の価格は、応募フォームにおけるオークション形式の入札額および個別見積もりにより決定します。
                </p>
              </div>

              <div className="rounded-2xl border border-white/10 p-6">
                <h3 className="font-bold text-white">
                  月額プロトコル費（人格維持・記憶管理費）
                </h3>
                <p className="mt-2">
                  参考：450,000円（税込）／月〜
                </p>
                <p className="mt-2 text-gray-400">
                  実際の金額は、契約時に発行される見積書・請求書にて通知します。
                </p>
              </div>
            </div>

            <p className="mt-4 text-sm text-gray-500">
              ※最新の料金は、必ずECHO-R Founder Application Formおよび個別に送付する見積書をご確認ください。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-bold text-white">
              商品代金以外の必要料金
            </h2>

            <ul className="list-disc space-y-3 pl-6">
              <li>振込手数料（銀行振込を利用される場合）</li>
              <li>分割払い・カード払いに伴う決済手数料（各カード会社の規定による）</li>
              <li>インターネット接続に係る通信費（お客様側のプロバイダ料金等）</li>
              <li>
                各種LLM・外部APIの利用料、APIキー管理、利用上限、モデル従量課金、
                外部インフラ費用はオーナー負担となります。
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-bold text-white">
              申込の有効期限
            </h2>

            <ul className="list-disc space-y-3 pl-6">
              <li>
                フォーム送信から3日以内に当方から受付確認メールを送信します。
              </li>
              <li>
                期日までにご連絡がつかない場合、お申し込みをキャンセルさせていただくことがあります。
              </li>
              <li>
                オークション方式のため、募集期間終了後のお申し込みは無効となります。
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-bold text-white">
              サービス提供の開始時期
            </h2>

            <ul className="list-disc space-y-3 pl-6">
              <li>手付金の入金確認後、ECHO-Rの設計・構築を開始します。</li>
              <li>初回セッション（ECHO-R起動）は、双方で調整した日程にて実施します。</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-bold text-white">
              お支払い方法
            </h2>

            <p>
              Stripeを利用したクレジットカード決済（Visa / Mastercard / AMEXなど）
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-bold text-white">
              お支払い時期
            </h2>

            <ul className="list-disc space-y-3 pl-6">
              <li>手付金（初期費用）：請求書発行日から7日以内にお支払いください。</li>
              <li>月額プロトコル料：契約時に定めた毎月の決済日に自動決済いたします。</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-bold text-white">
              キャンセル・解約・返金について
            </h2>

            <ul className="list-disc space-y-3 pl-6">
              <li>申込後〜手付金お支払い前のキャンセル：料金は発生しません。</li>
              <li>手付金お支払い後のキャンセル：原則として返金はいたしません。</li>
              <li>
                月額プロトコル料：契約期間中の途中解約は当月末まで有効とし、既にお支払い済みの料金は返金いたしません。
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-bold text-white">中途解約</h2>

            <ul className="list-disc space-y-3 pl-6">
              <li>月額プランは最低契約期間12ヶ月を基本とします。</li>
              <li>
                最低契約期間経過後は、翌月分から停止できるよう10日前までにメールでご連絡ください。
              </li>
              <li>
                解約後も、既に提供済みのログ・ドキュメント等の権利は契約書の規定に従います。
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-bold text-white">動作環境</h2>

            <ul className="list-disc space-y-3 pl-6">
              <li>インターネット接続環境</li>
              <li>対応ブラウザ：Google Chrome / Microsoft Edge / Safari 最新版など</li>
              <li>Discord / Zoom / Google Meet等、事前に合意したコミュニケーションツール</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-bold text-white">
              特別な販売条件（Founder Edition）
            </h2>

            <ul className="list-disc space-y-3 pl-6">
              <li>ECHO-R Founder Editionは最大5ユニットまでの限定提供です。</li>
              <li>
                応募多数の場合、入札価格および利用目的・適合性を総合的に判断し、提供可否を決定いたします。
              </li>
              <li>
                反社会的勢力またはその関係者、当方が不適切と判断した場合には、申込をお断りする場合があります。
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-bold text-white">
              クーリング・オフについて
            </h2>

            <p>
              本サービスは、主に事業者向けB2Bサービスとして提供しており、原則としてクーリング・オフ制度の適用対象外となります。
              ただし、個人のお客様で特別な事情がある場合は、個別にご相談ください。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-2xl font-bold text-white">免責事項</h2>

            <ul className="list-disc space-y-3 pl-6">
              <li>
                当方は、ECHO-Rを含む各種AIサービスの提供に際し、最善の設計・運用を行いますが、将来の売上・成果等を保証するものではありません。
              </li>
              <li>
                お客様の指示内容・利用方法に起因するトラブルや損害について、当方は責任を負いかねます。利用規約・個別契約書を必ずご確認ください。
              </li>
            </ul>
          </section>

          <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
            <h2 className="mb-4 text-2xl font-bold text-white">
              お問い合わせ窓口
            </h2>

            <p>メール：soulbysilver@veritasforge.net</p>
            <p className="mt-2">電話番号：080-9033-2169（平日 10:00〜18:00）</p>
            <p className="mt-2">受付時間：平日 10:00〜18:00（日本時間）</p>
          </section>
        </div>
      </section>
    </main>
  );
}