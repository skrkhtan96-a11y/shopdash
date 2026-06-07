const { Client } = require('ssh2');

const conn = new Client();

const config = {
    host: '153.92.211.46',
    port: 22,
    username: 'root',
    password: 'Eisa11223344@',
    readyTimeout: 30000
};

console.log("Connecting to VPS to fix Nginx configuration...");

conn.on('ready', () => {
    console.log("Connected!");
    
    // Commands to:
    // 1. Revert the duplicate we just inserted (remove first occurrence of client_max_body_size 50M; inside nginx.conf)
    // 2. View line 40-50 of nginx.conf to see what was duplicate
    // 3. Test nginx
    const revertCmd = "sed -i '0,/client_max_body_size 50M;/d' /etc/nginx/nginx.conf && sed -i '/client_max_body_size 50M;/d' /etc/nginx/nginx.conf || true";
    
    conn.exec(revertCmd, (err, stream) => {
        if (err) {
            console.error("Error reverting:", err);
            conn.end();
            return;
        }
        stream.on('close', () => {
            console.log("Revert command finished. Let's inspect the original nginx.conf line 40-50...");
            
            conn.exec("sed -n '35,55p' /etc/nginx/nginx.conf", (err, stream2) => {
                let linesOutput = '';
                stream2.on('close', () => {
                    console.log("nginx.conf lines 35-55:\n", linesOutput);
                    
                    // Let's modify the existing client_max_body_size (or check if it's there)
                    // Let's replace any existing client_max_body_size line in nginx.conf with client_max_body_size 100M;
                    // Or let's add it in /etc/nginx/sites-enabled/shop.nuzum.sbs.conf server block!
                    // Setting it in the specific site config is actually safer and avoids duplicate issues in nginx.conf!
                    // Let's check shop.nuzum.sbs.conf structure:
                    conn.exec("cat /etc/nginx/sites-enabled/shop.nuzum.sbs.conf", (err, stream3) => {
                        let confContent = '';
                        stream3.on('close', () => {
                            console.log("shop.nuzum.sbs.conf content:\n", confContent);
                            
                            // Let's inject client_max_body_size 100M; inside the server block of shop.nuzum.sbs.conf
                            // We can put it right after 'server {' or inside location block.
                            console.log("Injecting body size limit into shop.nuzum.sbs.conf...");
                            
                            const finalCmds = [
                                // Remove duplicate from nginx.conf just in case
                                "sed -i '/client_max_body_size/d' /etc/nginx/nginx.conf || true",
                                // Ensure standard client_max_body_size is set inside http block of nginx.conf (or we can just leave it to default and define it in server block)
                                // Add to server block in shop.nuzum.sbs.conf
                                "sed -i '/server {/a \\  client_max_body_size 100M;' /etc/nginx/sites-enabled/shop.nuzum.sbs.conf",
                                "nginx -t",
                                "systemctl restart nginx"
                            ];
                            executeSequential(finalCmds, 0);
                        }).on('data', data => confContent += data.toString());
                    });
                }).on('data', data => linesOutput += data.toString());
            });
        });
    });
}).on('error', (err) => {
    console.error("SSH connection error:", err);
}).connect(config);

function executeSequential(commands, index) {
    if (index >= commands.length) {
        console.log("Nginx configuration corrected and restarted successfully!");
        conn.end();
        return;
    }
    const cmd = commands[index];
    console.log(`Executing: ${cmd}`);
    conn.exec(cmd, (err, stream) => {
        if (err) {
            console.error(`Error: ${err}`);
            conn.end();
            return;
        }
        stream.on('close', () => {
            executeSequential(commands, index + 1);
        }).on('data', (data) => {
            process.stdout.write(data.toString());
        }).stderr.on('data', (data) => {
            process.stderr.write(data.toString());
        });
    });
}
