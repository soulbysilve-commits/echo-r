import LanguageSwitch from "../components/LanguageSwitch";
export default function About() {
    return (
        <main className="min-h-screen bg-black text-white p-20">
      <LanguageSwitch current="en" enHref="/about" jaHref="/ja/about" />
            <h1>about Us</h1>
        </main>
    );
}