#!/usr/bin/env python3
"""
EyeCX Distribution Engine v1.0
==============================

Transform expired domains into SEO assets and distribution channels.

"Eye" for screening/seeing history + "CX" for Common Crawl integration

PIPELINE:
1. ACQUIRE: EyeCX finds high-value expired domains
2. RESTORE: Auto-download + clean Wayback content
3. DEPLOY: Push to Cloudflare Pages as static sites
4. MONETIZE: Insert affiliate links, ads, email capture
5. DISTRIBUTE: Build link network, sell placements, syndicate content

RISK MITIGATIONS (CRITICAL):
┌────────────────────────────────────────────────────────────────┐
│  COMPLIANCE & SAFETY RULES                                     │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ❌ NEVER DO:                                                  │
│  • Import/use old email lists (CAN-SPAM, GDPR, CCPA)          │
│  • Access old user databases or accounts                       │
│  • Copy content verbatim (copyright violation)                 │
│  • Redirect mismatched niches (finance→pets = penalty)        │
│  • Enable catch-all email (password reset exploits)           │
│  • Build spammy low-quality PBN                               │
│                                                                │
│  ✅ ALWAYS DO:                                                 │
│  • Rewrite/improve Wayback content (not copy)                 │
│  • Build fresh opt-in email lists only                        │
│  • Match niche when redirecting (topical relevance)           │
│  • Apply for fresh affiliate accounts                         │
│  • Quality content + natural linking                          │
│  • Consult lawyer for bankruptcy domain edge cases            │
│                                                                │
└────────────────────────────────────────────────────────────────┘

BUSINESS MODEL:
┌────────────────────────────────────────────────────────────────┐
│  EYECX ECOSYSTEM                                       │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  [ACQUIRE]          [RESTORE]           [MONETIZE]            │
│  200K-500K/day  →   Auto Wayback   →   Affiliate + Ads        │
│  50 diamonds        Content             Display ads            │
│  200 golds          Cleanup             Email capture          │
│                     Deploy to CF        Link sales             │
│                                                                │
│  [DISTRIBUTE]                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │
│  │ Subscription│  │ Link Network│  │  Syndication│           │
│  │ Lists       │  │ (PBN-lite)  │  │  API        │           │
│  │ $19-99/mo   │  │ $50-500/link│  │  RSS/JSON   │           │
│  └─────────────┘  └─────────────┘  └─────────────┘           │
│                                                                │
└────────────────────────────────────────────────────────────────┘

Author: KJS @ Artisans F&B Corp
"""

import asyncio
import aiohttp
import json
import os
import re
import sqlite3
from datetime import datetime
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any, Set
from pathlib import Path
from urllib.parse import urljoin, urlparse
import hashlib
import zipfile
import io


# ============ CONFIG ============
@dataclass
class DistributionConfig:
    """Configuration for distribution engine."""
    
    # Paths
    output_dir: str = "./restored_sites"
    db_path: str = "./eyecx.db"
    
    # Cloudflare deployment
    cf_account_id: str = ""
    cf_api_token: str = ""
    cf_pages_project_prefix: str = "eyecx-"  # Projects named eyecx-{domain}
    
    # Wayback restoration
    wayback_limit_pages: int = 100  # Max pages to restore per domain
    wayback_timeout: int = 30
    clean_archive_urls: bool = True  # Remove archive.org references
    
    # COMPLIANCE: Content rewriting (don't copy verbatim)
    rewrite_content: bool = True  # Paraphrase instead of copy
    min_content_change_pct: float = 30.0  # Minimum % change from original
    add_freshness_signals: bool = True  # Add dates, updates, new sections
    
    # Monetization defaults
    default_ad_slots: int = 3
    default_affiliate_network: str = "amazon"  # amazon, shareasale, cj
    insert_email_capture: bool = True
    email_capture_provider: str = "mailchimp"  # or convertkit, beehiiv
    
    # COMPLIANCE: Email list rules
    email_list_fresh_only: bool = True  # NEVER import old lists
    email_require_double_optin: bool = True  # GDPR/CAN-SPAM compliant
    
    # COMPLIANCE: Catch-all email security
    enable_catchall_email: bool = False  # Disabled - password reset exploit risk
    catchall_warning_shown: bool = False
    
    # Link network
    enable_internal_linking: bool = True
    max_outbound_links_per_page: int = 3
    
    # COMPLIANCE: Niche matching (prevent penalty from mismatch)
    enforce_niche_match: bool = True  # Only redirect/link within same niche
    niche_match_threshold: float = 0.6  # Minimum similarity score
    
    # COMPLIANCE: PBN quality rules
    min_words_per_page: int = 500  # No thin content
    unique_content_required: bool = True  # No duplicate across network
    natural_link_velocity: bool = True  # Don't add all links at once
    max_links_per_day: int = 5  # Gradual link building
    
    # Niche mappings for affiliate programs
    niche_affiliates: Dict[str, List[str]] = field(default_factory=lambda: {
        "tech": ["amazon", "bestbuy", "newegg"],
        "finance": ["creditcards.com", "nerdwallet", "bankrate"],
        "health": ["amazon", "iherb", "vitacost"],
        "travel": ["booking.com", "expedia", "airbnb"],
        "saas": ["appsumo", "capterra", "g2"],
        "gaming": ["amazon", "gamestop", "steam"],
        "fashion": ["amazon", "nordstrom", "asos"],
        "home": ["amazon", "wayfair", "homedepot"],
    })
    
    # COMPLIANCE: Niche compatibility matrix (which niches can redirect to which)
    niche_compatibility: Dict[str, List[str]] = field(default_factory=lambda: {
        "tech": ["tech", "saas", "gaming"],
        "finance": ["finance"],
        "health": ["health"],
        "travel": ["travel"],
        "saas": ["saas", "tech"],
        "gaming": ["gaming", "tech"],
        "fashion": ["fashion"],
        "home": ["home"],
        "general": ["tech", "finance", "health", "travel", "saas", "gaming", "fashion", "home"],
    })
    
    def __post_init__(self):
        self.cf_account_id = os.getenv('CLOUDFLARE_ACCOUNT_ID', self.cf_account_id)
        self.cf_api_token = os.getenv('CLOUDFLARE_API_TOKEN', self.cf_api_token)


# ============ COMPLIANCE CHECKER ============
class ComplianceChecker:
    """
    Validates operations against legal and SEO best practices.
    
    BLOCKS:
    - Old email list imports
    - Niche mismatches
    - Thin/duplicate content
    - Catch-all email without warning
    """
    
    def __init__(self, config: DistributionConfig):
        self.config = config
        self.violations = []
    
    def check_email_list_import(self, list_source: str) -> bool:
        """BLOCK: Never allow importing old email lists."""
        if "import" in list_source.lower() or "old" in list_source.lower():
            self.violations.append({
                'type': 'EMAIL_LIST_VIOLATION',
                'severity': 'CRITICAL',
                'message': 'Importing old email lists violates CAN-SPAM, GDPR, CCPA',
                'action': 'BLOCKED'
            })
            return False
        return True
    
    def check_niche_match(self, source_niche: str, target_niche: str) -> bool:
        """Validate niche compatibility for redirects/links."""
        if not self.config.enforce_niche_match:
            return True
        
        compatible = self.config.niche_compatibility.get(source_niche, [])
        if target_niche not in compatible and source_niche != target_niche:
            self.violations.append({
                'type': 'NICHE_MISMATCH',
                'severity': 'HIGH',
                'message': f'Cannot redirect {source_niche} to {target_niche} - topical mismatch',
                'action': 'BLOCKED'
            })
            return False
        return True
    
    def check_content_quality(self, word_count: int, is_unique: bool) -> bool:
        """Validate content meets quality thresholds."""
        passed = True
        
        if word_count < self.config.min_words_per_page:
            self.violations.append({
                'type': 'THIN_CONTENT',
                'severity': 'MEDIUM',
                'message': f'Page has {word_count} words, minimum is {self.config.min_words_per_page}',
                'action': 'WARNING'
            })
            passed = False
        
        if self.config.unique_content_required and not is_unique:
            self.violations.append({
                'type': 'DUPLICATE_CONTENT',
                'severity': 'HIGH',
                'message': 'Content duplicated across network - risks penalty',
                'action': 'BLOCKED'
            })
            passed = False
        
        return passed
    
    def check_catchall_email(self) -> bool:
        """Warn about catch-all email security risks."""
        if self.config.enable_catchall_email and not self.config.catchall_warning_shown:
            self.violations.append({
                'type': 'CATCHALL_SECURITY_RISK',
                'severity': 'MEDIUM',
                'message': 'Catch-all email exposes you to password reset exploits and scams',
                'action': 'WARNING'
            })
            return False
        return True
    
    def check_link_velocity(self, links_today: int) -> bool:
        """Validate natural link building pace."""
        if self.config.natural_link_velocity and links_today > self.config.max_links_per_day:
            self.violations.append({
                'type': 'UNNATURAL_LINK_VELOCITY',
                'severity': 'MEDIUM',
                'message': f'Adding {links_today} links/day looks unnatural, max is {self.config.max_links_per_day}',
                'action': 'WARNING'
            })
            return False
        return True
    
    def get_violations(self) -> List[Dict]:
        """Get all recorded violations."""
        return self.violations
    
    def clear_violations(self):
        """Clear violation log."""
        self.violations = []
    
    def has_blockers(self) -> bool:
        """Check if any blocking violations exist."""
        return any(v['action'] == 'BLOCKED' for v in self.violations)


# ============ CONTENT REWRITER ============
class ContentRewriter:
    """
    Rewrite Wayback content to avoid copyright issues.
    
    COMPLIANCE: Don't copy verbatim - paraphrase and improve.
    """
    
    def __init__(self, config: DistributionConfig):
        self.config = config
    
    def rewrite_html(self, html: str, domain: str) -> str:
        """
        Transform restored HTML to be sufficiently different from original.
        
        Changes:
        1. Add freshness signals (dates, "Updated" notices)
        2. Restructure content blocks
        3. Add new sections (disclaimer, about, related)
        4. Modify headings and meta
        """
        if not self.config.rewrite_content:
            return html
        
        # Add freshness notice at top of body
        freshness_notice = f'''
<div class="eyecx-freshness-notice" style="background: #e8f5e9; padding: 15px; margin: 20px 0; border-radius: 5px; border-left: 4px solid #4caf50;">
    <strong>📅 Updated {datetime.now().strftime('%B %Y')}</strong> - This content has been reviewed and updated.
</div>
'''
        
        # Add disclaimer at bottom
        disclaimer = f'''
<div class="eyecx-disclaimer" style="margin-top: 40px; padding: 20px; background: #f5f5f5; border-radius: 5px; font-size: 14px; color: #666;">
    <p><strong>Disclaimer:</strong> This site has been rebuilt and updated. The information provided is for general purposes only. 
    Always verify current details from official sources. This site is independently operated and not affiliated with any previous owners.</p>
    <p>© {datetime.now().year} - All content on this site is original or has been substantially modified from public archives.</p>
</div>
'''
        
        # Insert freshness notice after <body>
        if '<body' in html.lower():
            html = re.sub(
                r'(<body[^>]*>)',
                r'\1' + freshness_notice,
                html,
                flags=re.I
            )
        
        # Insert disclaimer before </body>
        if '</body>' in html.lower():
            html = re.sub(
                r'(</body>)',
                disclaimer + r'\1',
                html,
                flags=re.I
            )
        
        # Update title to show freshness
        html = re.sub(
            r'<title>([^<]+)</title>',
            lambda m: f'<title>{m.group(1)} | Updated {datetime.now().year}</title>',
            html,
            flags=re.I
        )
        
        # Add meta tags for freshness
        meta_tags = f'''
<meta name="revised" content="{datetime.now().isoformat()}">
<meta name="robots" content="index, follow">
<meta property="article:modified_time" content="{datetime.now().isoformat()}">
'''
        html = re.sub(r'(<head[^>]*>)', r'\1' + meta_tags, html, flags=re.I)
        
        return html
    
    def calculate_change_percentage(self, original: str, modified: str) -> float:
        """Calculate how much content has changed."""
        # Simple word-level diff
        orig_words = set(re.findall(r'\b\w+\b', original.lower()))
        mod_words = set(re.findall(r'\b\w+\b', modified.lower()))
        
        if not orig_words:
            return 100.0
        
        new_words = mod_words - orig_words
        change_pct = (len(new_words) / len(orig_words)) * 100
        
        return min(change_pct, 100.0)
    
    def add_original_content_sections(self, html: str, niche: str) -> str:
        """Add original content sections to increase uniqueness."""
        
        # Niche-specific additional sections
        sections = {
            'tech': '''
<section class="eyecx-added-section" style="margin: 30px 0; padding: 20px; background: #f8f9fa; border-radius: 8px;">
    <h2>💡 Quick Tips</h2>
    <ul>
        <li>Always check for the latest updates and patches</li>
        <li>Compare multiple sources before making decisions</li>
        <li>Consider your specific needs and budget</li>
    </ul>
</section>
''',
            'finance': '''
<section class="eyecx-added-section" style="margin: 30px 0; padding: 20px; background: #fff3e0; border-radius: 8px;">
    <h2>⚠️ Important Notice</h2>
    <p>This content is for informational purposes only and should not be considered financial advice. 
    Always consult with a qualified financial advisor before making investment decisions.</p>
</section>
''',
            'health': '''
<section class="eyecx-added-section" style="margin: 30px 0; padding: 20px; background: #e3f2fd; border-radius: 8px;">
    <h2>🏥 Health Disclaimer</h2>
    <p>The information on this site is not intended to replace professional medical advice. 
    Always consult with a healthcare provider for medical concerns.</p>
</section>
''',
        }
        
        section = sections.get(niche, sections.get('tech', ''))
        
        # Insert before disclaimer
        if '<div class="eyecx-disclaimer"' in html:
            html = html.replace('<div class="eyecx-disclaimer"', section + '<div class="eyecx-disclaimer"')
        elif '</body>' in html.lower():
            html = re.sub(r'(</body>)', section + r'\1', html, flags=re.I)
        
        return html


# ============ WAYBACK RESTORER ============
class WaybackRestorer:
    """
    Download and restore website content from Wayback Machine.
    
    Process:
    1. Get list of archived URLs
    2. Download HTML for each URL
    3. Clean archive.org references
    4. Extract and download images/assets
    5. Generate clean static site
    """
    
    CDX_API = "https://web.archive.org/cdx/search/cdx"
    WAYBACK_URL = "https://web.archive.org/web"
    
    def __init__(self, config: DistributionConfig, session: aiohttp.ClientSession):
        self.config = config
        self.session = session
    
    async def restore_domain(self, domain: str, target_date: str = None) -> Dict[str, Any]:
        """
        Restore a domain from Wayback Machine.
        
        Args:
            domain: Domain to restore
            target_date: Optional YYYYMMDD date to target (uses latest if None)
        
        Returns:
            Dict with restoration results and file paths
        """
        result = {
            'domain': domain,
            'pages_restored': 0,
            'assets_downloaded': 0,
            'output_path': None,
            'errors': [],
            'content_analysis': {}
        }
        
        # Create output directory
        output_path = Path(self.config.output_dir) / domain.replace('.', '_')
        output_path.mkdir(parents=True, exist_ok=True)
        result['output_path'] = str(output_path)
        
        # Get archived URLs
        urls = await self._get_archived_urls(domain, target_date)
        if not urls:
            result['errors'].append("No archived URLs found")
            return result
        
        # Download and clean pages
        for url_info in urls[:self.config.wayback_limit_pages]:
            try:
                page_result = await self._download_page(url_info, output_path)
                if page_result:
                    result['pages_restored'] += 1
                    result['assets_downloaded'] += page_result.get('assets', 0)
            except Exception as e:
                result['errors'].append(f"Failed to restore {url_info['url']}: {str(e)}")
        
        # Analyze content for niche detection
        result['content_analysis'] = await self._analyze_content(output_path)
        
        # Generate index if missing
        await self._ensure_index(output_path, domain)
        
        return result
    
    async def _get_archived_urls(self, domain: str, target_date: str = None) -> List[Dict]:
        """Get list of archived URLs from CDX API."""
        urls = []
        
        try:
            params = {
                'url': f'{domain}/*',
                'output': 'json',
                'fl': 'timestamp,original,statuscode,mimetype',
                'filter': 'statuscode:200',
                'collapse': 'urlkey',
                'limit': self.config.wayback_limit_pages * 2
            }
            
            if target_date:
                params['from'] = target_date
                params['to'] = target_date
            
            async with self.session.get(self.CDX_API, params=params, timeout=30) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    if data and len(data) > 1:
                        for row in data[1:]:
                            if len(row) >= 4 and 'text/html' in row[3]:
                                urls.append({
                                    'timestamp': row[0],
                                    'url': row[1],
                                    'status': row[2],
                                    'mimetype': row[3]
                                })
        except Exception as e:
            pass
        
        return urls
    
    async def _download_page(self, url_info: Dict, output_path: Path) -> Optional[Dict]:
        """Download and clean a single page."""
        timestamp = url_info['timestamp']
        original_url = url_info['url']
        
        # Construct Wayback URL
        wayback_url = f"{self.WAYBACK_URL}/{timestamp}/{original_url}"
        
        try:
            async with self.session.get(wayback_url, timeout=self.config.wayback_timeout) as resp:
                if resp.status != 200:
                    return None
                
                html = await resp.text()
                
                # Clean HTML
                if self.config.clean_archive_urls:
                    html = self._clean_wayback_html(html, timestamp)
                
                # Determine output filename
                parsed = urlparse(original_url)
                path = parsed.path.strip('/') or 'index'
                if not path.endswith('.html'):
                    path = path + '/index.html' if path else 'index.html'
                
                # Ensure path doesn't escape output directory
                safe_path = Path(path).as_posix().replace('..', '')
                file_path = output_path / safe_path
                file_path.parent.mkdir(parents=True, exist_ok=True)
                
                # Write file
                with open(file_path, 'w', encoding='utf-8') as f:
                    f.write(html)
                
                # Count assets (images in HTML)
                asset_count = len(re.findall(r'<img[^>]+src=', html, re.I))
                
                return {'path': str(file_path), 'assets': asset_count}
                
        except Exception as e:
            return None
    
    def _clean_wayback_html(self, html: str, timestamp: str) -> str:
        """Remove Wayback Machine artifacts from HTML."""
        
        # Remove Wayback toolbar/banner
        html = re.sub(
            r'<!-- BEGIN WAYBACK TOOLBAR INSERT -->.*?<!-- END WAYBACK TOOLBAR INSERT -->',
            '', html, flags=re.DOTALL
        )
        
        # Remove Wayback script injections
        html = re.sub(
            r'<script[^>]*web\.archive\.org[^>]*>.*?</script>',
            '', html, flags=re.DOTALL | re.I
        )
        
        # Clean Wayback URLs in src/href attributes
        # Pattern: //web.archive.org/web/TIMESTAMP/http...
        html = re.sub(
            r'(src|href)=["\'](?:https?:)?//web\.archive\.org/web/\d+/([^"\']+)["\']',
            r'\1="\2"', html, flags=re.I
        )
        
        # Remove Wayback comment markers
        html = re.sub(r'<!--\s*FILE ARCHIVED ON.*?-->', '', html, flags=re.DOTALL)
        
        # Clean inline styles pointing to archive
        html = re.sub(
            r'url\(["\']?(?:https?:)?//web\.archive\.org/web/\d+/([^)"\']+)["\']?\)',
            r'url("\1")', html, flags=re.I
        )
        
        return html
    
    async def _analyze_content(self, output_path: Path) -> Dict:
        """Analyze restored content to detect niche and keywords."""
        analysis = {
            'detected_niche': 'general',
            'keywords': [],
            'page_count': 0,
            'word_count': 0
        }
        
        # Niche keyword patterns
        niche_patterns = {
            'tech': ['software', 'app', 'code', 'developer', 'api', 'cloud', 'saas'],
            'finance': ['money', 'invest', 'stock', 'crypto', 'bank', 'loan', 'credit'],
            'health': ['health', 'fitness', 'diet', 'medical', 'wellness', 'nutrition'],
            'travel': ['travel', 'hotel', 'flight', 'vacation', 'destination', 'tour'],
            'gaming': ['game', 'gaming', 'esport', 'console', 'steam', 'play'],
            'fashion': ['fashion', 'style', 'clothing', 'outfit', 'wear', 'designer'],
            'home': ['home', 'furniture', 'decor', 'garden', 'kitchen', 'bedroom'],
        }
        
        text_content = []
        
        # Read all HTML files
        for html_file in output_path.rglob('*.html'):
            try:
                with open(html_file, 'r', encoding='utf-8', errors='ignore') as f:
                    content = f.read()
                    # Extract text from HTML
                    text = re.sub(r'<[^>]+>', ' ', content)
                    text = re.sub(r'\s+', ' ', text)
                    text_content.append(text.lower())
                    analysis['page_count'] += 1
            except:
                pass
        
        all_text = ' '.join(text_content)
        analysis['word_count'] = len(all_text.split())
        
        # Detect niche
        niche_scores = {}
        for niche, keywords in niche_patterns.items():
            score = sum(all_text.count(kw) for kw in keywords)
            niche_scores[niche] = score
        
        if niche_scores:
            analysis['detected_niche'] = max(niche_scores, key=niche_scores.get)
        
        # Extract top keywords (simple frequency)
        words = re.findall(r'\b[a-z]{4,15}\b', all_text)
        word_freq = {}
        stopwords = {'this', 'that', 'with', 'from', 'have', 'been', 'were', 'will', 'more', 'your'}
        for word in words:
            if word not in stopwords:
                word_freq[word] = word_freq.get(word, 0) + 1
        
        top_keywords = sorted(word_freq.items(), key=lambda x: x[1], reverse=True)[:20]
        analysis['keywords'] = [kw for kw, _ in top_keywords]
        
        return analysis
    
    async def _ensure_index(self, output_path: Path, domain: str):
        """Ensure index.html exists."""
        index_path = output_path / 'index.html'
        if not index_path.exists():
            # Create simple index listing all pages
            pages = list(output_path.rglob('*.html'))
            html = f"""<!DOCTYPE html>
<html>
<head>
    <title>{domain}</title>
    <meta charset="utf-8">
</head>
<body>
    <h1>{domain}</h1>
    <p>Restored content:</p>
    <ul>
"""
            for page in pages[:50]:
                rel_path = page.relative_to(output_path)
                html += f'        <li><a href="{rel_path}">{rel_path}</a></li>\n'
            
            html += """    </ul>
</body>
</html>"""
            
            with open(index_path, 'w') as f:
                f.write(html)


# ============ MONETIZATION ENGINE ============
class MonetizationEngine:
    """
    Insert monetization elements into restored sites.
    
    Elements:
    - Affiliate links (contextual)
    - Display ad slots
    - Email capture forms
    - Internal links to other portfolio sites
    """
    
    # Affiliate link templates
    AFFILIATE_TEMPLATES = {
        'amazon': '<a href="https://www.amazon.com/s?k={keyword}&tag={tag}" rel="sponsored nofollow">{anchor}</a>',
        'shareasale': '<a href="https://www.shareasale.com/r.cfm?b={banner}&u={user}&m={merchant}" rel="sponsored">{anchor}</a>',
    }
    
    # Ad slot HTML
    AD_SLOT_TEMPLATE = '''
<div class="eyecx-ad-slot" data-slot="{slot_id}" style="margin: 20px 0; padding: 15px; background: #f5f5f5; text-align: center;">
    <!-- Ad Slot {slot_id} -->
    <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
    <ins class="adsbygoogle" style="display:block" data-ad-client="{adsense_id}" data-ad-slot="{slot_id}"></ins>
    <script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
</div>
'''
    
    # Email capture template
    EMAIL_CAPTURE_TEMPLATE = '''
<div class="eyecx-email-capture" style="margin: 30px 0; padding: 25px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 10px; color: white;">
    <h3 style="margin: 0 0 10px 0;">Get Updates</h3>
    <p style="margin: 0 0 15px 0; opacity: 0.9;">Subscribe for the latest content.</p>
    <form action="{form_action}" method="post" style="display: flex; gap: 10px; flex-wrap: wrap;">
        <input type="email" name="email" placeholder="Your email" required 
               style="flex: 1; min-width: 200px; padding: 10px; border: none; border-radius: 5px;">
        <button type="submit" style="padding: 10px 20px; background: #1a1a2e; color: white; border: none; border-radius: 5px; cursor: pointer;">
            Subscribe
        </button>
    </form>
</div>
'''
    
    def __init__(self, config: DistributionConfig):
        self.config = config
    
    def monetize_site(
        self,
        site_path: str,
        niche: str,
        affiliate_tag: str = "domainhunter-20",
        adsense_id: str = None,
        email_form_action: str = None
    ) -> Dict[str, int]:
        """
        Add monetization to all pages in a restored site.
        
        Returns count of elements inserted.
        """
        stats = {
            'pages_processed': 0,
            'affiliate_links': 0,
            'ad_slots': 0,
            'email_forms': 0
        }
        
        site_path = Path(site_path)
        
        for html_file in site_path.rglob('*.html'):
            try:
                with open(html_file, 'r', encoding='utf-8', errors='ignore') as f:
                    html = f.read()
                
                original_html = html
                
                # Insert affiliate links
                if niche in self.config.niche_affiliates:
                    html, link_count = self._insert_affiliate_links(
                        html, niche, affiliate_tag
                    )
                    stats['affiliate_links'] += link_count
                
                # Insert ad slots
                if adsense_id:
                    html, ad_count = self._insert_ad_slots(html, adsense_id)
                    stats['ad_slots'] += ad_count
                
                # Insert email capture
                if self.config.insert_email_capture and email_form_action:
                    html, email_inserted = self._insert_email_capture(
                        html, email_form_action
                    )
                    stats['email_forms'] += email_inserted
                
                # Write back if modified
                if html != original_html:
                    with open(html_file, 'w', encoding='utf-8') as f:
                        f.write(html)
                    stats['pages_processed'] += 1
                    
            except Exception as e:
                pass
        
        return stats
    
    def _insert_affiliate_links(
        self, html: str, niche: str, tag: str
    ) -> tuple[str, int]:
        """Insert contextual affiliate links."""
        count = 0
        
        # Keywords that should become affiliate links
        niche_keywords = {
            'tech': ['software', 'laptop', 'phone', 'computer', 'tablet', 'headphones'],
            'finance': ['credit card', 'savings account', 'investment', 'insurance'],
            'health': ['vitamins', 'supplements', 'fitness equipment', 'protein'],
            'travel': ['hotel', 'flight', 'luggage', 'backpack', 'camera'],
            'gaming': ['gaming mouse', 'keyboard', 'headset', 'monitor', 'console'],
            'fashion': ['shoes', 'dress', 'jacket', 'handbag', 'watch'],
            'home': ['furniture', 'mattress', 'kitchen', 'vacuum', 'decor'],
        }
        
        keywords = niche_keywords.get(niche, [])
        
        for keyword in keywords:
            # Find keyword mentions not already in links
            pattern = rf'(?<!["\'>])({re.escape(keyword)})(?!["\'\<])'
            matches = list(re.finditer(pattern, html, re.I))
            
            # Limit to 2 links per keyword
            for match in matches[:2]:
                affiliate_link = f'<a href="https://www.amazon.com/s?k={keyword.replace(" ", "+")}&tag={tag}" rel="sponsored nofollow">{match.group(1)}</a>'
                html = html[:match.start()] + affiliate_link + html[match.end():]
                count += 1
                # Re-match after modification
                break
        
        return html, count
    
    def _insert_ad_slots(self, html: str, adsense_id: str) -> tuple[str, int]:
        """Insert ad slots at strategic positions."""
        count = 0
        
        # Find </p> tags and insert after every 3rd paragraph
        paragraphs = list(re.finditer(r'</p>', html, re.I))
        
        slot_positions = []
        for i, match in enumerate(paragraphs):
            if (i + 1) % 3 == 0 and count < self.config.default_ad_slots:
                slot_positions.append(match.end())
                count += 1
        
        # Insert from end to preserve positions
        for pos in reversed(slot_positions):
            slot_html = self.AD_SLOT_TEMPLATE.format(
                slot_id=f"eyecx-{count}",
                adsense_id=adsense_id
            )
            html = html[:pos] + slot_html + html[pos:]
        
        return html, count
    
    def _insert_email_capture(
        self, html: str, form_action: str
    ) -> tuple[str, int]:
        """Insert email capture form before closing body tag."""
        
        email_html = self.EMAIL_CAPTURE_TEMPLATE.format(form_action=form_action)
        
        # Insert before </body>
        if '</body>' in html.lower():
            html = re.sub(
                r'(</body>)',
                email_html + r'\1',
                html,
                flags=re.I
            )
            return html, 1
        
        return html, 0


# ============ LINK NETWORK MANAGER ============
class LinkNetworkManager:
    """
    Manage internal linking between portfolio sites.
    
    Features:
    - Track all portfolio domains
    - Generate contextual internal links
    - Create link wheels and tiers
    - Report on link distribution
    """
    
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.conn = None
    
    def connect(self):
        self.conn = sqlite3.connect(self.db_path)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS portfolio_sites (
                domain TEXT PRIMARY KEY,
                niche TEXT,
                deployed_url TEXT,
                page_count INTEGER DEFAULT 0,
                outbound_links INTEGER DEFAULT 0,
                inbound_links INTEGER DEFAULT 0,
                created_at TEXT,
                last_updated TEXT
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS link_placements (
                id INTEGER PRIMARY KEY,
                source_domain TEXT,
                target_domain TEXT,
                anchor_text TEXT,
                page_url TEXT,
                created_at TEXT,
                UNIQUE(source_domain, target_domain, page_url)
            )
        """)
        self.conn.commit()
    
    def add_site(self, domain: str, niche: str, url: str, page_count: int):
        """Add a deployed site to the portfolio."""
        now = datetime.utcnow().isoformat()
        self.conn.execute("""
            INSERT OR REPLACE INTO portfolio_sites 
            (domain, niche, deployed_url, page_count, created_at, last_updated)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (domain, niche, url, page_count, now, now))
        self.conn.commit()
    
    def get_link_targets(self, source_niche: str, exclude_domain: str, limit: int = 5) -> List[Dict]:
        """Get related portfolio sites to link to."""
        cursor = self.conn.execute("""
            SELECT domain, deployed_url, niche, inbound_links
            FROM portfolio_sites
            WHERE domain != ? AND (niche = ? OR niche = 'general')
            ORDER BY inbound_links ASC
            LIMIT ?
        """, (exclude_domain, source_niche, limit))
        
        return [
            {'domain': row[0], 'url': row[1], 'niche': row[2], 'inbound': row[3]}
            for row in cursor.fetchall()
        ]
    
    def record_link(self, source: str, target: str, anchor: str, page_url: str):
        """Record a link placement."""
        self.conn.execute("""
            INSERT OR IGNORE INTO link_placements
            (source_domain, target_domain, anchor_text, page_url, created_at)
            VALUES (?, ?, ?, ?, ?)
        """, (source, target, anchor, page_url, datetime.utcnow().isoformat()))
        
        # Update counters
        self.conn.execute(
            "UPDATE portfolio_sites SET outbound_links = outbound_links + 1 WHERE domain = ?",
            (source,)
        )
        self.conn.execute(
            "UPDATE portfolio_sites SET inbound_links = inbound_links + 1 WHERE domain = ?",
            (target,)
        )
        self.conn.commit()
    
    def get_network_stats(self) -> Dict:
        """Get network statistics."""
        sites = self.conn.execute("SELECT COUNT(*) FROM portfolio_sites").fetchone()[0]
        links = self.conn.execute("SELECT COUNT(*) FROM link_placements").fetchone()[0]
        
        by_niche = {}
        for row in self.conn.execute("SELECT niche, COUNT(*) FROM portfolio_sites GROUP BY niche"):
            by_niche[row[0]] = row[1]
        
        return {
            'total_sites': sites,
            'total_links': links,
            'by_niche': by_niche
        }


# ============ CLOUDFLARE PAGES DEPLOYER ============
class CloudflarePagesDeployer:
    """
    Deploy restored sites to Cloudflare Pages.
    
    Features:
    - Create Pages project per domain
    - Upload static files
    - Configure custom domains
    - Track deployment status
    """
    
    API_BASE = "https://api.cloudflare.com/client/v4"
    
    def __init__(self, config: DistributionConfig):
        self.config = config
        self.session = None
    
    async def __aenter__(self):
        headers = {
            'Authorization': f'Bearer {self.config.cf_api_token}',
            'Content-Type': 'application/json'
        }
        self.session = aiohttp.ClientSession(headers=headers)
        return self
    
    async def __aexit__(self, *args):
        if self.session:
            await self.session.close()
    
    async def deploy_site(self, domain: str, site_path: str) -> Dict[str, Any]:
        """
        Deploy a restored site to Cloudflare Pages.
        
        Returns deployment URL and status.
        """
        result = {
            'domain': domain,
            'project_name': None,
            'deployment_url': None,
            'status': 'pending',
            'error': None
        }
        
        # Create project name (sanitized)
        project_name = self.config.cf_pages_project_prefix + re.sub(r'[^a-z0-9]', '-', domain.lower())[:30]
        result['project_name'] = project_name
        
        try:
            # Create project if doesn't exist
            project = await self._get_or_create_project(project_name)
            if not project:
                result['error'] = "Failed to create Pages project"
                return result
            
            # Create deployment with files
            deployment = await self._create_deployment(project_name, site_path)
            if deployment:
                result['deployment_url'] = deployment.get('url')
                result['status'] = 'success'
            else:
                result['error'] = "Deployment failed"
                
        except Exception as e:
            result['error'] = str(e)
            result['status'] = 'failed'
        
        return result
    
    async def _get_or_create_project(self, project_name: str) -> Optional[Dict]:
        """Get existing project or create new one."""
        # Check if exists
        url = f"{self.API_BASE}/accounts/{self.config.cf_account_id}/pages/projects/{project_name}"
        async with self.session.get(url) as resp:
            if resp.status == 200:
                data = await resp.json()
                return data.get('result')
        
        # Create new
        url = f"{self.API_BASE}/accounts/{self.config.cf_account_id}/pages/projects"
        payload = {
            'name': project_name,
            'production_branch': 'main'
        }
        
        async with self.session.post(url, json=payload) as resp:
            if resp.status in [200, 201]:
                data = await resp.json()
                return data.get('result')
        
        return None
    
    async def _create_deployment(self, project_name: str, site_path: str) -> Optional[Dict]:
        """Upload files and create deployment."""
        
        # Create ZIP of site files
        site_path = Path(site_path)
        zip_buffer = io.BytesIO()
        
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
            for file_path in site_path.rglob('*'):
                if file_path.is_file():
                    arcname = file_path.relative_to(site_path)
                    zf.write(file_path, arcname)
        
        zip_buffer.seek(0)
        
        # Upload via Pages API
        url = f"{self.API_BASE}/accounts/{self.config.cf_account_id}/pages/projects/{project_name}/deployments"
        
        # Use multipart form
        data = aiohttp.FormData()
        data.add_field('file', zip_buffer, filename='site.zip', content_type='application/zip')
        
        # Remove content-type header for multipart
        headers = {'Authorization': f'Bearer {self.config.cf_api_token}'}
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, data=data, headers=headers) as resp:
                if resp.status in [200, 201]:
                    result = await resp.json()
                    return result.get('result')
        
        return None
    
    async def configure_custom_domain(self, project_name: str, domain: str) -> bool:
        """Add custom domain to Pages project."""
        url = f"{self.API_BASE}/accounts/{self.config.cf_account_id}/pages/projects/{project_name}/domains"
        
        async with self.session.post(url, json={'name': domain}) as resp:
            return resp.status in [200, 201]


# ============ SUBSCRIPTION DELIVERY SYSTEM ============
class SubscriptionDelivery:
    """
    Generate and deliver domain lists to subscribers.
    
    Tiers:
    - Premium ($99/mo): 500 domains/day, score 70+, includes restoration
    - Standard ($49/mo): 200 domains/day, score 55+
    - Basic ($19/mo): 50 domains/day, score 40+
    """
    
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.conn = None
    
    def connect(self):
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
    
    def generate_daily_list(
        self,
        tier: str,
        subscriber_id: str,
        include_restoration_urls: bool = False
    ) -> Dict:
        """Generate daily domain list for subscriber."""
        
        tier_config = {
            'premium': {'limit': 500, 'min_score': 70},
            'standard': {'limit': 200, 'min_score': 55},
            'basic': {'limit': 50, 'min_score': 40}
        }
        
        config = tier_config.get(tier, tier_config['basic'])
        
        # Get domains not yet delivered to this subscriber
        cursor = self.conn.execute("""
            SELECT d.domain, d.tld, d.score, d.tier, d.flip_value,
                   d.pr, d.snapshots, d.age_years, d.majestic_rank
            FROM domains d
            WHERE d.score >= ?
            AND d.status = 'available'
            ORDER BY d.score DESC, d.first_seen DESC
            LIMIT ?
        """, (config['min_score'], config['limit']))
        
        domains = []
        for row in cursor.fetchall():
            domain_data = dict(row)
            
            # Add restoration URL for premium
            if include_restoration_urls and tier == 'premium':
                domain_data['wayback_url'] = f"https://web.archive.org/web/*/{row['domain']}"
            
            domains.append(domain_data)
        
        return {
            'subscriber_id': subscriber_id,
            'tier': tier,
            'generated_at': datetime.utcnow().isoformat(),
            'count': len(domains),
            'domains': domains
        }
    
    def export_to_json(self, data: Dict, filepath: str):
        """Export list to JSON file."""
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2)
    
    def export_to_csv(self, data: Dict, filepath: str):
        """Export list to CSV file."""
        import csv
        
        if not data.get('domains'):
            return
        
        with open(filepath, 'w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=data['domains'][0].keys())
            writer.writeheader()
            writer.writerows(data['domains'])


# ============ MAIN DISTRIBUTION ENGINE ============
class DistributionEngine:
    """
    Main orchestrator for the distribution pipeline.
    
    Pipeline:
    1. COMPLIANCE CHECK - Validate operation is legal/safe
    2. Get high-value domains from EyeCX DB
    3. Restore content from Wayback
    4. REWRITE content (copyright compliance)
    5. Add monetization elements
    6. Deploy to Cloudflare Pages
    7. Add to link network (with niche matching)
    8. Generate subscription lists
    """
    
    def __init__(self, config: DistributionConfig = None):
        self.config = config or DistributionConfig()
        self.logger = self._setup_logger()
        self.compliance = ComplianceChecker(self.config)
        self.rewriter = ContentRewriter(self.config)
    
    def _setup_logger(self):
        import logging
        logger = logging.getLogger("DistributionEngine")
        if not logger.handlers:
            logger.setLevel(logging.INFO)
            h = logging.StreamHandler()
            h.setFormatter(logging.Formatter("%(asctime)s │ %(message)s", "%H:%M:%S"))
            logger.addHandler(h)
        return logger
    
    async def process_domain(
        self,
        domain: str,
        affiliate_tag: str = "domainhunter-20",
        adsense_id: str = None,
        email_form: str = None,
        deploy: bool = True,
        target_niche: str = None  # For redirect validation
    ) -> Dict[str, Any]:
        """
        Full pipeline for a single domain with compliance checks.
        
        1. Pre-flight compliance checks
        2. Restore from Wayback
        3. Rewrite content (copyright)
        4. Monetize
        5. Deploy to CF Pages
        6. Add to link network (with niche validation)
        """
        result = {
            'domain': domain,
            'restoration': None,
            'monetization': None,
            'deployment': None,
            'compliance': {'passed': True, 'violations': []},
            'status': 'pending'
        }
        
        # Pre-flight compliance
        self.compliance.clear_violations()
        self.compliance.check_catchall_email()
        
        if self.compliance.has_blockers():
            result['compliance']['passed'] = False
            result['compliance']['violations'] = self.compliance.get_violations()
            result['status'] = 'blocked_compliance'
            self.logger.error(f"❌ Compliance block: {self.compliance.get_violations()}")
            return result
        
        async with aiohttp.ClientSession() as session:
            # Step 1: Restore
            self.logger.info(f"[1/5] Restoring {domain}...")
            restorer = WaybackRestorer(self.config, session)
            restoration = await restorer.restore_domain(domain)
            result['restoration'] = restoration
            
            if not restoration.get('pages_restored'):
                result['status'] = 'restoration_failed'
                return result
            
            # Step 2: Rewrite content (COPYRIGHT COMPLIANCE)
            self.logger.info(f"[2/5] Rewriting content for copyright compliance...")
            detected_niche = restoration.get('content_analysis', {}).get('detected_niche', 'general')
            rewrite_stats = await self._rewrite_site_content(
                restoration['output_path'], 
                detected_niche
            )
            result['rewrite_stats'] = rewrite_stats
            
            # Step 3: Niche match validation (if redirecting)
            if target_niche:
                if not self.compliance.check_niche_match(detected_niche, target_niche):
                    result['compliance']['passed'] = False
                    result['compliance']['violations'] = self.compliance.get_violations()
                    result['status'] = 'blocked_niche_mismatch'
                    self.logger.error(f"❌ Niche mismatch: {detected_niche} → {target_niche}")
                    return result
            
            # Step 4: Monetize
            self.logger.info(f"[3/5] Monetizing {domain}...")
            monetizer = MonetizationEngine(self.config)
            
            monetization = monetizer.monetize_site(
                restoration['output_path'],
                detected_niche,
                affiliate_tag=affiliate_tag,
                adsense_id=adsense_id,
                email_form_action=email_form
            )
            result['monetization'] = monetization
            
            # Step 5: Deploy
            if deploy and self.config.cf_api_token:
                self.logger.info(f"[4/5] Deploying {domain}...")
                async with CloudflarePagesDeployer(self.config) as deployer:
                    deployment = await deployer.deploy_site(
                        domain, restoration['output_path']
                    )
                    result['deployment'] = deployment
            
            # Step 6: Add to link network (with niche validation)
            self.logger.info(f"[5/5] Adding to link network...")
            network = LinkNetworkManager(self.config.db_path)
            network.connect()
            
            deploy_url = result.get('deployment', {}).get('deployment_url', '')
            network.add_site(
                domain, detected_niche, deploy_url,
                restoration.get('pages_restored', 0)
            )
            
            # Record compliance status
            result['compliance']['violations'] = self.compliance.get_violations()
            result['compliance']['passed'] = not self.compliance.has_blockers()
            result['status'] = 'success'
            
            # Log warnings
            warnings = [v for v in self.compliance.get_violations() if v['action'] == 'WARNING']
            if warnings:
                self.logger.warning(f"⚠️ Compliance warnings: {len(warnings)}")
                for w in warnings:
                    self.logger.warning(f"   {w['type']}: {w['message']}")
        
        return result
    
    async def _rewrite_site_content(self, site_path: str, niche: str) -> Dict:
        """Rewrite all HTML files for copyright compliance."""
        stats = {'files_processed': 0, 'avg_change_pct': 0}
        change_pcts = []
        
        site_path = Path(site_path)
        
        for html_file in site_path.rglob('*.html'):
            try:
                with open(html_file, 'r', encoding='utf-8', errors='ignore') as f:
                    original = f.read()
                
                # Apply rewrites
                modified = self.rewriter.rewrite_html(original, str(html_file))
                modified = self.rewriter.add_original_content_sections(modified, niche)
                
                # Calculate change percentage
                change_pct = self.rewriter.calculate_change_percentage(original, modified)
                change_pcts.append(change_pct)
                
                # Check minimum change threshold
                if change_pct < self.config.min_content_change_pct:
                    self.logger.warning(f"   Low change ({change_pct:.1f}%): {html_file.name}")
                
                # Write back
                with open(html_file, 'w', encoding='utf-8') as f:
                    f.write(modified)
                
                stats['files_processed'] += 1
                
            except Exception as e:
                self.logger.debug(f"Rewrite failed for {html_file}: {e}")
        
        stats['avg_change_pct'] = sum(change_pcts) / len(change_pcts) if change_pcts else 0
        self.logger.info(f"   Rewrote {stats['files_processed']} files, avg change: {stats['avg_change_pct']:.1f}%")
        
        return stats
    
    async def batch_process(
        self,
        domains: List[str],
        **kwargs
    ) -> List[Dict]:
        """Process multiple domains with compliance tracking."""
        results = []
        blocked = 0
        success = 0
        
        for i, domain in enumerate(domains, 1):
            self.logger.info(f"\n{'='*50}")
            self.logger.info(f"Processing {i}/{len(domains)}: {domain}")
            self.logger.info('='*50)
            
            result = await self.process_domain(domain, **kwargs)
            results.append(result)
            
            if result['status'] == 'success':
                success += 1
            elif 'blocked' in result['status']:
                blocked += 1
            
            # Rate limit
            await asyncio.sleep(2)
        
        # Summary with compliance stats
        self.logger.info(f"\n{'='*50}")
        self.logger.info(f"BATCH COMPLETE")
        self.logger.info(f"  ✅ Success: {success}/{len(domains)}")
        self.logger.info(f"  ❌ Blocked (compliance): {blocked}/{len(domains)}")
        self.logger.info('='*50)
        
        return results


# ============ CLI ============
async def main():
    import argparse
    
    parser = argparse.ArgumentParser(description="EyeCX Distribution Engine")
    parser.add_argument('--domain', type=str, help='Single domain to process')
    parser.add_argument('--domains-file', type=str, help='File with domains to process')
    parser.add_argument('--affiliate-tag', type=str, default='domainhunter-20')
    parser.add_argument('--adsense', type=str, help='AdSense publisher ID')
    parser.add_argument('--email-form', type=str, help='Email signup form action URL')
    parser.add_argument('--no-deploy', action='store_true', help='Skip deployment')
    parser.add_argument('--output', type=str, default='./restored_sites')
    
    args = parser.parse_args()
    
    config = DistributionConfig(output_dir=args.output)
    engine = DistributionEngine(config)
    
    domains = []
    if args.domain:
        domains = [args.domain]
    elif args.domains_file and os.path.exists(args.domains_file):
        with open(args.domains_file) as f:
            domains = [l.strip() for l in f if l.strip() and not l.startswith('#')]
    
    if not domains:
        print("No domains specified. Use --domain or --domains-file")
        return
    
    results = await engine.batch_process(
        domains,
        affiliate_tag=args.affiliate_tag,
        adsense_id=args.adsense,
        email_form=args.email_form,
        deploy=not args.no_deploy
    )
    
    # Summary
    success = sum(1 for r in results if r['status'] == 'success')
    print(f"\n{'='*50}")
    print(f"COMPLETE: {success}/{len(results)} domains processed successfully")
    print('='*50)


if __name__ == "__main__":
    asyncio.run(main())
