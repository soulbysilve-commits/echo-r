import type { Metadata } from "next";
import LanguageSwitch from "../../components/LanguageSwitch";

export const metadata: Metadata = {
  title: "プライバシーポリシー | Veritas Forge",
  alternates: {
    canonical: "https://echo-r.veritasforge.net/ja/privacy",
    languages: {
      en: "https://echo-r.veritasforge.net/privacy",
      ja: "https://echo-r.veritasforge.net/ja/privacy",
    },
  },
};

export default function PrivacyPolicy() {
  return (
    <main className="min-h-screen bg-black text-gray-300 py-24 px-6 selection:bg-blue-500/30">
      <LanguageSwitch current="ja" enHref="/privacy" jaHref="/ja/privacy" />
      <div className="mx-auto max-w-3xl">
        <a href="/ja" className="mb-8 inline-block text-sm font-bold uppercase tracking-widest text-blue-400 hover:text-blue-300">
          ← ECHO-Rへ戻る
        </a>

        <h1 className="mb-4 text-4xl font-black tracking-tight text-white md:text-5xl">
          プライバシーポリシー
        </h1>
        <p className="mb-12 text-sm text-gray-500 uppercase tracking-widest">
          最終更新日：2026年6月
        </p>

        <div className="space-y-10 text-gray-400">
          <p className="leading-relaxed">
            Veritas Forge（以下「当社」）は、利用者の個人情報の保護を重要な責務と考え、以下の方針に基づいて個人情報を取り扱います。
          </p>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white border-b border-white/10 pb-2">1. 取得する情報</h2>
            <p className="mb-2 leading-relaxed">当社は以下の情報を取得する場合があります。</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pl-4">
              <ul className="list-outside list-disc space-y-1">
                <li>氏名</li>
                <li>メールアドレス</li>
                <li>電話番号</li>
                <li>所属組織</li>
              </ul>
              <ul className="list-outside list-disc space-y-1">
                <li>決済情報</li>
                <li>フォーム送信内容</li>
                <li>サービス利用履歴</li>
                <li>AIとの対話データ</li>
              </ul>
            </div>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white border-b border-white/10 pb-2">2. 利用目的</h2>
            <p className="mb-2 leading-relaxed">取得した情報は以下の目的で利用します。</p>
            <ul className="ml-5 list-outside list-disc space-y-1">
              <li>サービス提供</li>
              <li>本人確認</li>
              <li>問い合わせ対応</li>
              <li>請求および決済</li>
              <li>サービス改善</li>
              <li>不正利用防止</li>
              <li>法令対応</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white border-b border-white/10 pb-2">3. 第三者提供</h2>
            <p className="leading-relaxed">
              当社は法令に基づく場合を除き、利用者の同意なく個人情報を第三者へ提供しません。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white border-b border-white/10 pb-2">4. 外部サービス</h2>
            <p className="mb-2 leading-relaxed">当社は以下の外部サービスを利用する場合があります。</p>
            <ul className="ml-5 list-outside list-disc space-y-1 mb-4">
              <li>Stripe</li>
              <li>Google Forms</li>
              <li>Google Workspace</li>
              <li>Discord</li>
              <li>Zoom</li>
              <li>Cloudflare</li>
            </ul>
            <p className="leading-relaxed text-sm text-gray-500">
              これらのサービスには各社のプライバシーポリシーが適用されます。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white border-b border-white/10 pb-2">5. データ保存</h2>
            <p className="leading-relaxed">
              利用者情報は適切なセキュリティ対策のもと管理します。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white border-b border-white/10 pb-2">6. 保有期間</h2>
            <p className="leading-relaxed">
              取得した情報は、利用目的達成に必要な期間保有します。<br />
              法令上保存義務がある場合はその期間保存します。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white border-b border-white/10 pb-2">7. 開示・訂正・削除</h2>
            <p className="leading-relaxed">
              利用者は自己の個人情報について開示、訂正、削除を請求できます。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white border-b border-white/10 pb-2">8. Cookie等</h2>
            <p className="leading-relaxed">
              当社ウェブサイトではアクセス解析や利便性向上のためCookie等を使用する場合があります。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white border-b border-white/10 pb-2">9. ポリシー変更</h2>
            <p className="leading-relaxed">
              本ポリシーは必要に応じて改定される場合があります。
            </p>
          </section>

          <section>
            <h2 className="mb-4 text-xl font-bold text-white border-b border-white/10 pb-2">10. お問い合わせ</h2>
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 text-sm">
              <p className="font-bold text-white mb-2">Veritas Forge</p>
              <p>Email: <a href="mailto:soulbysilver@veritasforge.net" className="text-blue-400 hover:underline">soulbysilver@veritasforge.net</a></p>
              <p>受付時間: 平日 10:00〜18:00（日本時間）</p>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}