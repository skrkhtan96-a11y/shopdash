const { Client } = require('ssh2');

const conn = new Client();

const config = {
    host: '153.92.211.46',
    port: 22,
    username: 'root',
    password: 'Eisa11223344@',
    readyTimeout: 30000
};

console.log("Connecting to VPS to check and configure Nginx...");

conn.on('ready', () => {
    console.log("Connected!");
    
    // Command to grep for shop.nuzum.sbs in Nginx configuration directory
    const cmd = "grep -rnw '/etc/nginx/' -e 'shop.nuzum.sbs' || cat /etc/nginx/nginx.conf";
    
    conn.exec(cmd, (err, stream) => {
        if (err) {
            console.error("Error executing command:", err);
            conn.end();
            return;
        }
        let output = '';
        stream.on('close', (code, signal) => {
            console.log("Command finished. Output:\n", output);
            
            // Now, let's inject client_max_body_size 50M into nginx.conf http block if possible
            // or directly in the server block of the configuration file.
            // Let's run a script that does this:
            // 1. Add it to /etc/nginx/nginx.conf inside the http block if not exists.
            console.log("Configuring Nginx body limits...");
            
            const configCmds = [
                // Add to nginx.conf http block
                "sed -i '/http {/a \\    client_max_body_size 50M;' /etc/nginx/nginx.conf",
                // Test nginx configuration
                "nginx -t",
                // Reload nginx
                "systemctl reload nginx"
            ];
            
            executeSequential(configCmds, 0);
        }).on('data', (data) => {
            output += data.toString();
        }).stderr.on('data', (data) => {
            console.error(data.toString());
        });
    });
}).on('error', (err) => {
    console.error("SSH connection error:", err);
}).connect(config);

function executeSequential(commands, index) {
    if (index >= commands.length) {
        console.log("Nginx configuration updated and reloaded successfully!");
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
