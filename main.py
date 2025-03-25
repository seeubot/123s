import re
import json
import requests
from bs4 import BeautifulSoup
import fastapi
import uvicorn
from typing import List, Dict, Optional
from pydantic import BaseModel
from fastapi import HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

class DownloadLink(BaseModel):
    filename: str
    size: Optional[str] = None
    direct_link: str

class TeraboxScraper:
    def __init__(self):
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        }
        
        # List of Terabox downloader sites to try
        self.downloader_sites = [
            'https://terabox.servehttp.com/api',
            'https://teraboxapp.com/s/api',
            'https://terabox-dl.qtcloud.workers.dev/api',
        ]

    def extract_terabox_code(self, url):
        """
        Extract the Terabox share code from the URL
        """
        # Try different URL pattern matches
        patterns = [
            r'surl=([a-zA-Z0-9]+)',
            r'share/init\?surl=([a-zA-Z0-9]+)',
            r'(1[a-zA-Z0-9]+)'
        ]
        
        for pattern in patterns:
            match = re.search(pattern, url)
            if match:
                return match.group(1)
        
        raise ValueError("Could not extract Terabox share code from URL")

    def fetch_download_links(self, terabox_url):
        """
        Try multiple downloader APIs to fetch download links
        """
        # Extract share code
        share_code = self.extract_terabox_code(terabox_url)
        
        # Try each downloader site
        for site in self.downloader_sites:
            try:
                # Construct API request
                api_url = f"{site}?link={terabox_url}"
                
                # Send request
                response = requests.get(api_url, headers=self.headers, timeout=10)
                
                # Check if request was successful
                if response.status_code == 200:
                    # Try to parse JSON response
                    try:
                        data = response.json()
                        
                        # Different APIs might have different response structures
                        download_links = []
                        
                        # Common parsing approaches
                        if isinstance(data, list):
                            # Direct list of links
                            for item in data:
                                download_links.append(DownloadLink(
                                    filename=item.get('filename', 'Unknown'),
                                    size=item.get('size', 'N/A'),
                                    direct_link=item.get('download_link', item.get('url', ''))
                                ))
                        elif isinstance(data, dict):
                            # Dictionary with files or download info
                            files = data.get('files', data.get('list', []))
                            if files:
                                for file in files:
                                    download_links.append(DownloadLink(
                                        filename=file.get('filename', file.get('name', 'Unknown')),
                                        size=file.get('size', 'N/A'),
                                        direct_link=file.get('download_link', file.get('url', ''))
                                    ))
                        
                        # If links found, return them
                        if download_links:
                            return download_links
                    
                    except json.JSONDecodeError:
                        # Not a JSON response, continue to next site
                        continue
            
            except requests.RequestException:
                # Request failed, continue to next site
                continue
        
        # If no links found after trying all sites
        raise HTTPException(status_code=404, detail="No download links could be found")

# Initialize FastAPI app
app = FastAPI(
    title="Terabox Downloader API",
    description="Multi-site Terabox link extractor",
    version="1.0.0"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

# Initialize scraper
scraper = TeraboxScraper()

@app.get("/download", response_model=List[DownloadLink])
async def fetch_terabox_links(
    url: str = Query(..., description="Terabox shared URL")
):
    """
    Fetch download links from Terabox shared URL
    
    - Tries multiple external APIs
    - No cookies or login required
    """
    try:
        links = scraper.fetch_download_links(url)
        return links
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def main():
    """
    Run the API server
    """
    uvicorn.run(
        "terabox_scraper:app", 
        host="0.0.0.0", 
        port=8000, 
        reload=True
    )

if __name__ == "__main__":
    main()

# Requirements:
# pip install fastapi uvicorn requests beautifulsoup4 pydantic
