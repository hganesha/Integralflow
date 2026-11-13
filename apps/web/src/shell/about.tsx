import { Icon } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { useSession } from "../app/session";
import brandLogo from "../../icons/brand-about.png";
import styles from "./about.module.css";

export default function About() {
  const { environment } = useSession();
  return <article className={styles.page} aria-labelledby="about-title">
    <Link to="/" className={styles.backLink}><Icon name="arrowl" /> Back to app</Link>
    <header className={styles.intro}>
      <div className={styles.introCopy}>
        <span className="t-engraved">About IntegralFlow</span>
        <h1 id="about-title">From evidence to<br /><em>an accountable decision.</em></h1>
        <p>A workspace for financial-crime case work, specialist agents, and the policies that govern every step.</p>
      </div>
      <img className={styles.introLogo} src={brandLogo} alt="IntegralFlow logo" width={1536} height={1024} />
    </header>
    <a className={styles.story} href="/visual-story.html">
      <div><span className="t-engraved">The visual story</span><h2>How a case becomes a decision.</h2><p>Follow the journey through agents, skills, context, policy checks, and human review.</p><span className={styles.storyAction}>Explore the illustrated walkthrough <Icon name="arrowr" /></span></div>
      <Icon name="workflow" size="lg" />
    </a>
    <div className={styles.grid}>
      <section><Icon name="bot" /><h2>Bounded agent work</h2><p>Specialist mandates connect tasks, allowed skills, context subscriptions, and execution limits. Process Studio makes those boundaries visible; Authoring configures the process flow.</p></section>
      <section><Icon name="book" /><h2>Policy with provenance</h2><p>The policy catalog connects decision tables, evidence obligations, and document requirements. Policy Studio manages authoring and publication, with approval checked separately from catalog availability.</p></section>
      <section><Icon name="fingerprint" /><h2>A traceable case record</h2><p>Prepared context, service receipts, evidence, and authorized human decisions keep the path from a source to a case outcome inspectable.</p></section>
    </div>
    <footer className={styles.footer}><span>IntegralFlow · {environment.name}</span><span>Build {environment.build} · {environment.runtimeMode}</span>{environment.synthetic ? <span>Synthetic environment</span> : null}</footer>
  </article>;
}
