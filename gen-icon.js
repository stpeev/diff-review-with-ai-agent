const sharp = require('sharp');
const path = require('path');

const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <!-- Dark blue-gray rounded background -->
  <rect width="256" height="256" rx="40" fill="#1e1e2e"/>
  
  <!-- Code diff area -->
  <!-- Red deleted line -->
  <rect x="32" y="40" width="145" height="24" rx="4" fill="#ff6b6b" opacity="0.25"/>
  <text x="42" y="57" font-family="monospace" font-size="14" fill="#ff6b6b" font-weight="bold">−</text>
  <rect x="60" y="50" width="80" height="5" rx="2" fill="#ff6b6b" opacity="0.6"/>
  
  <!-- Green added line -->
  <rect x="32" y="72" width="145" height="24" rx="4" fill="#51cf66" opacity="0.25"/>
  <text x="42" y="89" font-family="monospace" font-size="14" fill="#51cf66" font-weight="bold">+</text>
  <rect x="60" y="82" width="100" height="5" rx="2" fill="#51cf66" opacity="0.6"/>
  
  <!-- Green added line 2 -->
  <rect x="32" y="104" width="145" height="24" rx="4" fill="#51cf66" opacity="0.25"/>
  <text x="42" y="121" font-family="monospace" font-size="14" fill="#51cf66" font-weight="bold">+</text>
  <rect x="60" y="114" width="70" height="5" rx="2" fill="#51cf66" opacity="0.6"/>
  
  <!-- Context lines (dimmed) -->
  <rect x="60" y="146" width="90" height="5" rx="2" fill="#ffffff" opacity="0.2"/>
  <rect x="60" y="162" width="65" height="5" rx="2" fill="#ffffff" opacity="0.2"/>
  <rect x="60" y="178" width="85" height="5" rx="2" fill="#ffffff" opacity="0.2"/>
  
  <!-- Comment bubble (yellow/amber) -->
  <rect x="115" y="130" width="115" height="80" rx="16" fill="#ffc107"/>
  <polygon points="130,210 142,228 156,210" fill="#ffc107"/>
  
  <!-- Comment lines in bubble -->
  <rect x="132" y="152" width="80" height="5" rx="2" fill="#1e1e2e" opacity="0.5"/>
  <rect x="132" y="164" width="60" height="5" rx="2" fill="#1e1e2e" opacity="0.5"/>
  <rect x="132" y="176" width="72" height="5" rx="2" fill="#1e1e2e" opacity="0.5"/>
  
  <!-- AI sparkle badge (purple) -->
  <circle cx="222" cy="126" r="24" fill="#7c4dff"/>
  <polygon points="222,112 225,122 235,122 227,128 230,138 222,132 214,138 217,128 209,122 219,122" fill="#ffffff"/>
</svg>`);

sharp(svg)
    .png()
    .toFile(path.join(__dirname, 'icon.png'))
    .then(info => console.log('Icon created:', info))
    .catch(err => console.error('Error:', err));
