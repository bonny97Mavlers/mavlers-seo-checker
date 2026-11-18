'use strict';
/**
 * Local fixture website with deliberate SEO defects — used to test the crawler
 * end-to-end without internet access.  Run: node fixtures/test-site.js  (port 4400)
 */
const express = require('express');
const app = express();
const PORT = Number(process.env.FIXTURE_PORT || 4400);
const B = `http://localhost:${PORT}`;
const FIXED = !!process.env.FIXED; // second-pass version with some issues fixed, for audit comparison tests

const page = ({ title, meta, h1s = [], body = '', schema = null, extraHead = '', lang = 'en-GB', noindex = false, canonical }) => `<!doctype html>
<html${lang ? ` lang="${lang}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${title != null ? `<title>${title}</title>` : ''}${meta ? `<meta name="description" content="${meta}">` : ''}
${noindex ? '<meta name="robots" content="noindex, follow">' : ''}${canonical ? `<link rel="canonical" href="${canonical}">` : ''}
<link rel="icon" href="/favicon.png"><meta property="og:site_name" content="Acme Studio">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234567"></script>
${schema ? `<script type="application/ld+json">${typeof schema === 'string' ? schema : JSON.stringify(schema)}</script>` : ''}${extraHead}
</head><body><header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/services/">Services</a> <a href="/blog/">Blog</a> <a href="/contact">Contact</a></nav></header>
<main>${h1s.map(h => `<h1>${h}</h1>`).join('')}${body}</main><footer><a href="/privacy-policy">Privacy</a></footer></body></html>`;

const lorem = (n, topic = 'web design') => Array.from({ length: n }, (_, i) => `Our ${topic} team helps growing businesses launch fast, accessible websites that convert visitors into customers${i % 3 ? '' : ' with clear messaging'}.`).join(' ');

const pages = {
  '/': () => page({ title: 'Web Design Agency for Growing Businesses | Acme Studio', meta: 'Acme Studio designs and builds fast, accessible websites for growing businesses across the UK. See our work and get a free website quote today.',
    h1s: ['Web Design for Growing Businesses'], canonical: `${B}/`,
    schema: { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite', name: 'Acme Studio', url: B }, { '@type': 'Organization', name: 'Acme Studio' }] },
    body: `<p>${lorem(12)}</p><h2>What we do</h2><p>${lorem(6)}</p><ul><li>Design</li><li>Build</li></ul>
      <a href="/services/web-design">Web design</a> <a href="/services/web_design_agency">Agency</a> <a href="/web-design-agency">Agency page</a>
      ${FIXED ? '' : '<a href="/broken-page">Broken</a> <a href="/old-page">Old page</a>'} <a href="https://staging.acme-client.com/preview">Preview</a>
      <img src="/img/hero-team.webp" alt="Acme design team in the studio" width="1200" height="600">` }),
  '/about': () => page({ title: FIXED ? 'About Acme Studio: Our Story, Team and Design Values | Acme Studio' : 'About Us | Acme Studio', meta: FIXED ? 'Meet the Acme Studio team: designers and developers building fast, accessible websites for growing businesses since 2012. Get to know us and say hello.' : null, h1s: FIXED ? ['About Acme Studio'] : ['About Acme', 'Our Story', 'Our Team'], canonical: `${B}/about`,
    body: `<p>${lorem(20, 'design studio')}</p><h4>Skipped level heading</h4><p>${lorem(4)}</p><a href="/services/">Services</a><a href="/contact">Contact</a>` }),
  '/services/': () => page({ title: 'Our Digital Services: Web Design, Development and SEO | Acme Studio', meta: 'Explore Acme Studio services including web design, WordPress development, Shopify builds and SEO for growing UK businesses. Contact our team today.',
    h1s: ['Digital Services'], canonical: `${B}/services/`,
    schema: { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [] },
    body: `<p>${lorem(15, 'digital services')}</p><h2>Web design</h2><a href="/services/web-design">Web design</a><a href="/services/wordpress">WordPress</a>` }),
  '/services/web-design': () => page({ title: 'Web Design Services | Acme Studio', meta: 'Our web design services help growing businesses look great online with fast, accessible, conversion-focused websites that are built to rank well and turn visitors into loyal paying customers every day.',
    h1s: ['Web Design Services'], canonical: `${B}/services/web-design`,
    body: `<p>${lorem(30)}</p><h2>Our process</h2><p>${lorem(5)}</p>
      <img src="/img/IMG_1234.JPG"><img src="/img/team photo.png" alt="image"><img src="/img/web-design-process.jpg" alt="Web design process diagram" width="800">
      <a href="/blog/best-web-design-services">Blog</a><a href="/contact">Contact</a><a href="http://insecure.example.com/x">ext</a>` }),
  '/services/wordpress': () => page({ title: 'WordPress Development Services for Business Websites | Acme Studio', meta: 'Custom WordPress development from Acme Studio: bespoke themes, plugins, WooCommerce and ongoing care plans for growing businesses. Book a free call today.',
    h1s: ['WordPress Development'], canonical: `${B}/services/wordpress`,
    schema: '{"@context":"https://schema.org","@type":"Service", "name": "WordPress" ,}',
    body: `<p>${lorem(25, 'WordPress development')}</p><h2>Themes</h2><h2>Plugins</h2><a href="/services/">Back</a><a href="/">Home</a>` }),
  '/web-design-agency': () => page({ title: 'Web Design Agency Services | Acme Studio', meta: 'Looking for a web design agency? Acme Studio delivers web design services for growing businesses with fast, accessible and beautiful websites. Call now.',
    h1s: ['Web Design Agency Services'], canonical: `${B}/web-design-agency`, body: `<p>${lorem(20)}</p><h2>Why us</h2><a href="/">Home</a>` }),
  '/blog/': () => page({ title: 'Blog | Acme Studio', meta: 'Web design tips.', h1s: ['Blog'], canonical: `${B}/blog/`,
    body: `<a href="/blog/best-web-design-services">Best web design services</a><a href="/blog/how-to-plan-a-website">Plan a website</a>` }),
  '/blog/best-web-design-services': () => page({ title: 'Best Web Design Services in 2026 | Acme Studio', meta: 'What makes the best web design services? We compare what growing businesses should look for in a web design agency in 2026. Read the full guide.',
    h1s: ['Best Web Design Services'], canonical: `${B}/blog/best-web-design-services`,
    schema: { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: 'Best Web Design Services', datePublished: '2026-01-10', image: `${B}/img/x.webp` },
    body: `<p>${lorem(40)}</p><h2>What should web design cost?</h2><p>${lorem(5)}</p><h2>How long does a website take?</h2><h2>Do I need SEO?</h2><a href="/services/web-design">Services</a>` }),
  '/blog/how-to-plan-a-website': () => page({ title: 'How to Plan a Website Project Step by Step Guide | Acme Studio', meta: 'A practical guide to planning your website project: goals, sitemap, content, budget and timeline, with a free checklist from the Acme Studio team. Read now.',
    h1s: ['How to Plan a Website'], canonical: `${B}/blog/how-to-plan-a-website`,
    schema: { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: 'How to Plan a Website', author: { '@type': 'Person', name: 'Sam' }, datePublished: '2026-02-01', image: `${B}/img/plan.webp` },
    body: `<p>${lorem(35, 'website planning')}</p><h2>Set goals</h2><ul><li>One</li></ul><a href="/blog/">Blog</a><a href="/contact">Contact</a><a href="/services/">Services</a>` }),
  '/contact': () => page({ title: 'Contact | Acme Studio', meta: 'Contact Acme Studio.', h1s: ['Contact us'], canonical: `${B}/contact`, body: '<p>Call us or email hello@acme.test.</p><a href="/thank-you">Send</a>' }),
  '/thank-you': () => page({ title: 'Thank You | Acme Studio', meta: 'Thanks', h1s: ['Thanks!'], body: '<p>We will be in touch.</p>' }),
  '/privacy-policy': () => page({ title: 'Privacy Policy | Acme Studio', meta: 'How Acme Studio collects, uses and protects your personal data.', h1s: ['Privacy Policy'], canonical: `${B}/privacy-policy`, body: `<p>${lorem(10, 'privacy')}</p>` }),
  '/orphan-page': () => page({ title: 'Orphan Landing Page | Acme Studio', meta: FIXED ? 'A focused landing page for our spring web design offer, with pricing, timelines and examples of recent client launches. Book a free consultation today.' : null, h1s: [FIXED ? 'Spring Web Design Offer' : ''], body: `<p>${lorem(8)}</p>`, noindex: false }),
  '/old-2': null,
};

app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n\nSitemap: ${B}/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${['/', '/about', '/services/', '/services/web-design', '/blog/best-web-design-services', '/orphan-page', '/missing-from-site', '/old-page'].map(p => `<url><loc>${B}${p}</loc></url>`).join('')}</urlset>`));
app.get('/old-page', (req, res) => res.redirect(301, '/old-2'));
app.get('/old-2', (req, res) => res.redirect(301, '/about'));
app.get('/services/web_design_agency', (req, res) => res.redirect(301, '/web-design-agency'));
app.get('/img/:f', (req, res) => { res.setHeader('Cache-Control', 'max-age=60'); res.type(req.params.f.split('.').pop()).send(Buffer.alloc(req.params.f.startsWith('IMG') ? 420 * 1024 : 30 * 1024)); });
app.get('/favicon.png', (req, res) => res.type('png').send(Buffer.alloc(10)));
for (const [p, fn] of Object.entries(pages)) if (fn) app.get(p, (req, res) => res.type('html').send(fn()));
app.use((req, res) => res.status(req.path === '/missing-from-site' || req.path === '/broken-page' ? 404 : 200).type('html').send(page({ title: 'Page not found | Acme Studio', h1s: ['Not found'] })));

app.listen(PORT, () => console.log(`fixture site on ${B}`));
