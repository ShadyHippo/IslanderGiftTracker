<script lang="ts">
  import { onMount } from 'svelte';
  import { navigate } from './router';
  import { authConfig, type AuthConfig } from './api';

  // Same mechanism as the login form: the server tells us which login door
  // exists (/api/auth/config, cached in localStorage under the same key), and
  // this page documents ONLY that door. A Google-only instance says nothing
  // about passwords; a password instance says nothing about Google.
  const CFG_KEY = 'acnh.authcfg';
  function cachedCfg(): AuthConfig | null {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (!raw) return null;
      const v: unknown = JSON.parse(raw);
      const mode = (v as AuthConfig | null)?.mode;
      if (mode === 'password' || mode === 'google') return v as AuthConfig;
    } catch {
      /* corrupt/private-mode: fall through as unknown */
    }
    return null;
  }
  let cfg = $state<AuthConfig | null>(cachedCfg());

  onMount(() => {
    void authConfig()
      .then((c) => {
        cfg = c;
        try {
          localStorage.setItem(CFG_KEY, JSON.stringify(c));
        } catch {
          /* storage unavailable: cached value (if any) still applies */
        }
      })
      .catch(() => {
        /* unreachable server: keep cached config (or stay generic) */
      });
  });
</script>

<div class="min-h-screen bg-green-50 dark:bg-black">
  <header class="sticky top-0 z-10 border-b border-green-200 bg-white/95 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur dark:border-green-800 dark:bg-green-950/95">
    <button
      onclick={() => void navigate('/')}
      class="rounded-lg border border-green-300 bg-white px-3 py-1.5 text-sm text-green-800 hover:bg-green-100 dark:border-green-700 dark:bg-green-950 dark:text-green-100 dark:hover:bg-green-800"
    >
      ← Back
    </button>
  </header>

  <main class="mx-auto max-w-2xl space-y-6 p-4 pb-16">
    <h1 class="text-2xl font-bold text-green-800 dark:text-green-100">Privacy policy</h1>
    <p class="text-xs text-green-600 dark:text-green-400">Last updated: September 2026</p>

    <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
      <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">The short version</h2>
      <p class="mb-2 text-sm leading-relaxed text-green-700 dark:text-green-300">
        This is a hobby project about tracking gifts for Animal Crossing
        villagers. Plainly: the only things ever stored about you are your
        <strong>email address</strong>, an <strong>anonymous Google account
        number</strong>, and the <strong>island notes you type into the
        app</strong> (favorite villagers, who lives on your island, and which
        gifts you've given). There are no passwords on this site. There is no
        advertising, no tracking, and nothing is sold to anyone — the whole
        point is that it's just a fun tool.
      </p>
      <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
        Everything below is written for normal people, not lawyers. This
        specific version of the site is the one this page is served from.
      </p>
    </section>

    {#if cfg === null}
      <p class="text-xs text-green-600 dark:text-green-400" role="status">
        Checking which sign-in this instance uses…
      </p>
    {:else if cfg.mode === 'google'}
      <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
        <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">1. What happens when you sign in with Google</h2>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          When you tap <strong>“Continue with Google”</strong>, Google shows you
          a screen saying the site can see your email address and basic profile
          info, and you choose which account to use. From that sign-in this site
          reads exactly two things and ignores everything else:
        </p>
        <ul class="mb-3 list-disc space-y-1 pl-5 text-sm leading-relaxed text-green-700 dark:text-green-300">
          <li><strong>Your email address</strong> — this is also your username here. We never email you.</li>
          <li>A <strong>permanent Google account number</strong> (not your email) that lets us recognize you next time, even if you change your email address later.</li>
        </ul>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          Google's permission screen also mentions “profile info” — that
          <em>can</em> include your name and profile picture, but this site
          never looks at those and doesn't save them. We have no access to your
          Google password, your contacts, your files, your search history, or
          anything else in your Google account. Ever.
        </p>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          <strong>What about the “token”?</strong> The one-time sign-in code
          Google issues is checked to make sure it's genuine and then thrown
          away immediately. It is <strong>not saved</strong>, and after you sign
          in we cannot reach into your Google account, see your activity, or do
          anything on your behalf. The only login key that exists afterwards is
          this site's own “you're logged in” cookie, described in section 6.
        </p>
        <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
          <strong>There are no passwords here.</strong> Not stored, not
          “hashed”, not anything — this version of the site has no password
          system at all. Your Google password stays with Google.
        </p>
      </section>

      <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
        <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">2. Exactly what we store about you</h2>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          Two small files are kept on the server, per person:
        </p>
        <ul class="mb-3 list-disc space-y-1 pl-5 text-sm leading-relaxed text-green-700 dark:text-green-300">
          <li><strong>Your account</strong>: the Google account number and email address from section 1, plus the date you joined.</li>
          <li><strong>Your island notebook</strong> — only the things <em>you</em> tick or type in the app:
            <ul class="mt-1 list-disc space-y-0.5 pl-5">
              <li>which villagers you've marked as <strong>favorite</strong>,</li>
              <li>which villagers you've marked as <strong>on your island</strong>, and</li>
              <li>which <strong>gifts</strong> you've ticked off as given (villager, item, and the date).</li>
            </ul>
          </li>
        </ul>
        <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
          That's the complete list. There is nothing else about you on the
          server — no location, no contacts, no photos, no device info, no
          browsing history.
        </p>
      </section>

      <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
        <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">3. Where your data lives, and who could see it</h2>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          This site is run by <strong>one person</strong> (a hobbyist — that's
          me) on <strong>a server in their home</strong>. That person is the
          only one with access to the server and the files on it.
        </p>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          The big, boring reference files (the villager catalog and pictures)
          are handed out through <strong>Cloudflare</strong>, a well-known
          content-delivery network, so the site loads quickly for everyone. To
          be completely open about it: internet traffic to this site passes
          through Cloudflare's network, so in theory Cloudflare is in the chain
          and could see traffic as it flows by. Cloudflare does not store your
          account or your island data — those live only on my home server — and
          we don't send them anything on purpose.
        </p>
        <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
          That is the entire list of parties involved: <strong>you, Google
          (only at the moment of sign-in), Cloudflare (only as a traffic
          relay), and me (the person who runs the server).</strong> There is no
          advertising network, no analytics company, no data broker, and no
          “sharing” — there is nothing to share and no one to share it with.
        </p>
      </section>

      <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
        <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">4. Is it really free?</h2>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          Yes. Free to use, no ads, no subscriptions, and no paid features now
          or planned. There is an optional <strong>“Buy me a coffee”</strong>
          button for people who feel generous — it's a tip jar, it doesn't
          unlock anything, and it has nothing to do with your data. If the site
          ever has to close down, the closure will be announced well in advance
          with clear instructions for everyone to download their data.
        </p>
      </section>

      <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
        <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">5. How long we keep it, and how to delete it</h2>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          Your data is kept until <strong>you delete it</strong>, or until the
          site itself stops running.
        </p>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          To delete it right now: open the app, go to <strong>About → Delete my
          account</strong>. One tap (plus a “are you sure?”) and the server
          immediately removes your account, your email address, and your island
          notebook. There are no backups waiting in the wings — when it's
          deleted, it's gone.
        </p>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          Two honest footnotes about “deleted”:
        </p>
        <ul class="mb-3 list-disc space-y-1 pl-5 text-sm leading-relaxed text-green-700 dark:text-green-300">
          <li>Because the app works offline, a copy of your island notebook also sits <strong>on your own device</strong> (in the browser's storage). Deleting your account doesn't reach into your phone — if you want that copy gone too, clear this site's data in your browser settings.</li>
          <li>If you'd rather keep it than delete it, use <strong>About → Download my data</strong> first: that saves your island notebook as a small file that belongs to you.</li>
        </ul>
        <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
          Because the whole project is open source, you can also download the
          code and run your own copy on your own computer any time — your data
          file works there too. The source is at
          <a
            href="https://github.com/ShadyHippo/IslanderGiftTracker"
            target="_blank"
            rel="noopener noreferrer"
            class="font-medium text-green-700 underline decoration-dotted hover:text-green-900 dark:text-green-300 dark:hover:text-green-50"
          >github.com/ShadyHippo/IslanderGiftTracker</a>.
        </p>
      </section>

      <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
        <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">6. What gets sent to the server, and encryption (the honest version)</h2>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          Only your island notebook from section 2 is uploaded, and only when it
          changes — a tiny file of a few dozen kilobytes. The big catalog and
          picture files are downloaded <em>to</em> your device, never uploaded.
        </p>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          <strong>In transit (while moving across the internet): encrypted.</strong>
          Your browser talks to this site over HTTPS, the same padlock you see
          on any secure website. It's scrambled while it travels, so someone
          snooping on the network can't read it.
        </p>
        <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
          <strong>At rest (while sitting on the server): not encrypted.</strong>
          The honest way to say this: the files on my home server are not
          scrambled, like a notebook on a shelf in a house. I could read them —
          I'd see the email you signed up with and the villagers/gifts you've
          logged — and so could anyone else with access to that machine, which
          is no one. I don't go reading people's notebooks, because there is
          nothing to gain from it, but I won't pretend it's impossible.
        </p>
      </section>

      <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
        <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">7. Staying signed in</h2>
        <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
          After you sign in, this site puts a small “session” cookie in your
          browser so you don't have to sign in again for up to 30 days. The key
          behind it lives only in the server's memory — it isn't written to the
          hard drive, and it's wiped automatically when it expires or when the
          server restarts (which would just mean signing in again). It's the
          only cookie this site uses.
        </p>
      </section>
    {:else}
      <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
        <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">1. What happens when you sign in with a username and password</h2>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          You pick a username and a password. The password is never stored in a
          readable form: the server keeps a scrambled “fingerprint” of it (a
          one-way hash) that can check your password when you type it but can't
          be turned back into the password itself. If you forget it, the owner
          of the server can reset it, but nobody can ever look it up.
        </p>
        <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
          No email address is asked for or stored in this mode — the account is
          just the name and the fingerprint.
        </p>
      </section>

      <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
        <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">2. Exactly what we store about you</h2>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          Two small files are kept on the server, per person:
        </p>
        <ul class="mb-3 list-disc space-y-1 pl-5 text-sm leading-relaxed text-green-700 dark:text-green-300">
          <li><strong>Your account</strong>: your username and the password fingerprint from section 1.</li>
          <li><strong>Your island notebook</strong> — only the things <em>you</em> tick or type in the app:
            <ul class="mt-1 list-disc space-y-0.5 pl-5">
              <li>which villagers you've marked as <strong>favorite</strong>,</li>
              <li>which villagers you've marked as <strong>on your island</strong>, and</li>
              <li>which <strong>gifts</strong> you've ticked off as given (villager, item, and the date).</li>
            </ul>
          </li>
        </ul>
        <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
          That's the complete list. The server keeps exactly one copy of your
          notebook per person — no extra backup copies.
        </p>
      </section>

      <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
        <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">3. Where your data lives, and who could see it</h2>
        <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
          This build is self-hosted: whoever runs it controls the server it runs
          on, and signing in happens entirely on that server — no outside
          services are involved. There is no advertising network, no analytics
          company, no data broker, and nothing is shared with anyone.
        </p>
      </section>

      <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
        <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">4. Is it really free?</h2>
        <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
          Yes. Free to use, no ads, no subscriptions, and no paid features. If
          a “Buy me a coffee” button is shown it's a purely optional tip jar —
          it unlocks nothing and has nothing to do with your data.
        </p>
      </section>

      <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
        <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">5. How long we keep it, and how to delete it</h2>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          Your data is kept until <strong>you delete it</strong>. Open the app,
          go to <strong>About → Delete my account</strong>, confirm, and the
          server immediately removes your account and your island notebook —
          there are no hidden backup copies.
        </p>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          Two honest footnotes about “deleted”:
        </p>
        <ul class="mb-3 list-disc space-y-1 pl-5 text-sm leading-relaxed text-green-700 dark:text-green-300">
          <li>A copy of your notebook also sits <strong>on your own device</strong> for offline use; clear this site's data in your browser settings to remove that too.</li>
          <li>Use <strong>About → Download my data</strong> first if you'd like a copy you keep for yourself.</li>
        </ul>
      </section>

      <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
        <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">6. What gets sent to the server, and encryption (the honest version)</h2>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          Only your island notebook from section 2 is uploaded, and only when it
          changes. The big catalog and picture files are downloaded <em>to</em>
          your device, never uploaded.
        </p>
        <p class="mb-3 text-sm leading-relaxed text-green-700 dark:text-green-300">
          <strong>In transit (while moving across the internet): encrypted.</strong>
          Sign-in and data sync happen over HTTPS (the padlock in the address
          bar), so your password and notebook are scrambled while travelling and
          can't be read by someone snooping on the network.
        </p>
        <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
          <strong>At rest (while sitting on the server): not encrypted.</strong>
          The honest way to say this: your username and island notebook sit as
          ordinary files on the server's disk, readable by whoever runs it. Your
          password is the exception — it's only ever stored as the one-way
          fingerprint described in section 1, which can't be unscrambled.
        </p>
      </section>

      <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
        <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">7. Staying signed in</h2>
        <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
          After you sign in, this site puts a small “session” cookie in your
          browser so you don't have to sign in again for up to 30 days. The key
          behind it lives only in the server's memory — it isn't written to the
          hard drive, and it's wiped automatically when it expires or when the
          server restarts (which would just mean signing in again). It's the
          only cookie this site uses.
        </p>
      </section>
    {/if}

    <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
      <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">What we don't do</h2>
      <ul class="list-disc space-y-1 pl-5 text-sm leading-relaxed text-green-700 dark:text-green-300">
        <li>No advertising, analytics, or tracking of any kind.</li>
        <li>No selling, renting, or sharing your data — ever, with anyone.</li>
        <li>No cookies except the single “stay signed in” one from section 7.</li>
      </ul>
    </section>

    <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
      <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">On your device</h2>
      <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
        To work offline, the app stores the villager catalog, pictures, and a
        copy of your island notebook in your browser's storage. That all stays
        on your device. Clearing this site's data in your browser removes it;
        anything already saved to the server is still safe there.
      </p>
    </section>

    <section class="rounded-xl border border-green-200 bg-white p-5 dark:border-green-800 dark:bg-green-950">
      <h2 class="mb-2 font-semibold text-green-900 dark:text-green-50">About this project</h2>
      <p class="text-sm leading-relaxed text-green-700 dark:text-green-300">
        This is a non-commercial fan project made by one hobbyist. Animal
        Crossing: New Horizons and all related assets are © Nintendo. This app
        is not affiliated with or endorsed by Nintendo. The full source code is
        public, so every claim on this page can be checked.
      </p>
    </section>

    <p class="text-center text-sm text-green-700 dark:text-green-300">
      Also read the
      <a
        href="/tos"
        class="font-medium text-green-700 underline decoration-dotted hover:text-green-900 dark:text-green-300 dark:hover:text-green-50"
      >Terms of Service</a>.
    </p>
  </main>
</div>
