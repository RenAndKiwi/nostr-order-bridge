#!/usr/bin/env php
<?php
/**
 * WooNostr Market Plugin Test Suite
 * 
 * Run from the WordPress root directory:
 *   cd /var/www/html && php test-plugin.php
 * 
 * Or specify WP path:
 *   php test-plugin.php /var/www/html
 */

// Find WordPress.
$wp_root = isset($argv[1]) ? $argv[1] : getcwd();
$wp_load = rtrim($wp_root, '/') . '/wp-load.php';

if (!file_exists($wp_load)) {
    // Try common paths.
    $try = ['/var/www/html/wp-load.php', '/var/www/wordpress/wp-load.php'];
    foreach ($try as $p) {
        if (file_exists($p)) { $wp_load = $p; break; }
    }
}

if (!file_exists($wp_load)) {
    die("❌ Cannot find wp-load.php. Run from WordPress root or pass path as argument.\n");
}

echo "Loading WordPress from: $wp_load\n\n";

// Suppress any output buffering from WP.
$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['REQUEST_URI'] = '/';
define('DOING_CRON', true); // Prevent redirects.
require_once $wp_load;

if (!function_exists('woo_nostr_market')) {
    die("❌ WooNostr Market plugin not active.\n");
}

$pass = 0;
$fail = 0;

function test_pass($msg) { global $pass; $pass++; echo "  ✅ $msg\n"; }
function test_fail($msg) { global $fail; $fail++; echo "  ❌ $msg\n"; }

// ========================================
echo "=== 1. PHP Extensions ===\n";
// ========================================

extension_loaded('gmp') ? test_pass('GMP extension loaded') : test_fail('GMP extension MISSING — run: apt-get install php-gmp');
extension_loaded('openssl') ? test_pass('OpenSSL extension loaded') : test_fail('OpenSSL extension MISSING');
class_exists('WooNostrMarket_Secp256k1') ? test_pass('Secp256k1 class loaded') : test_fail('Secp256k1 class not found');

if (!extension_loaded('gmp')) {
    die("\n❌ Cannot continue without GMP. Install it and re-run.\n");
}

// ========================================
echo "\n=== 2. Secp256k1 Key Derivation ===\n";
// ========================================

try {
    $ec = new WooNostrMarket_Secp256k1();
    
    // Known test vector: private key = 1 → specific public key.
    $test_priv = str_pad('1', 64, '0', STR_PAD_LEFT);
    $test_pub  = $ec->derive_public_key($test_priv);
    $expected  = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
    
    ($test_pub === $expected) ? test_pass('Key derivation correct (generator point)') : test_fail("Key derivation wrong: got $test_pub");
    
    // Test with a random key.
    $rand_priv = bin2hex(random_bytes(32));
    $rand_pub  = $ec->derive_public_key($rand_priv);
    (strlen($rand_pub) === 64 && ctype_xdigit($rand_pub)) ? test_pass("Random key derivation OK: $rand_pub") : test_fail('Random key derivation failed');
    
} catch (Exception $e) {
    test_fail('Secp256k1 error: ' . $e->getMessage());
}

// ========================================
echo "\n=== 3. ECDH Shared Secret ===\n";
// ========================================

try {
    $alice_priv = bin2hex(random_bytes(32));
    $alice_pub  = $ec->derive_public_key($alice_priv);
    
    $bob_priv = bin2hex(random_bytes(32));
    $bob_pub  = $ec->derive_public_key($bob_priv);
    
    // Both sides should compute the same shared secret.
    $secret_ab = $ec->ecdh($alice_priv, $bob_pub);
    $secret_ba = $ec->ecdh($bob_priv, $alice_pub);
    
    ($secret_ab === $secret_ba) ? test_pass('ECDH shared secrets match') : test_fail("ECDH mismatch: $secret_ab vs $secret_ba");
    
} catch (Exception $e) {
    test_fail('ECDH error: ' . $e->getMessage());
}

// ========================================
echo "\n=== 4. NIP-04 Encrypt/Decrypt ===\n";
// ========================================

try {
    $sender_priv = bin2hex(random_bytes(32));
    $sender_pub  = $ec->derive_public_key($sender_priv);
    
    $settings      = woo_nostr_market()->settings;
    $merchant_pub  = $settings->get_public_key();
    $merchant_priv = $settings->get_private_key();
    
    if (empty($merchant_priv) || empty($merchant_pub)) {
        test_fail('No merchant keys configured in plugin — configure Nostr keys first');
    } else {
        test_pass("Merchant pubkey: " . substr($merchant_pub, 0, 16) . '...');
        
        // Encrypt as sender → merchant.
        $shared_hex = $ec->ecdh($sender_priv, $merchant_pub);
        $shared     = hex2bin($shared_hex);
        $iv         = openssl_random_pseudo_bytes(16);
        $plaintext  = '{"type":0,"id":"test-' . time() . '","items":[{"product_id":"1","quantity":1}],"shipping_id":"zone_0"}';
        $ciphertext = openssl_encrypt($plaintext, 'aes-256-cbc', $shared, OPENSSL_RAW_DATA, $iv);
        $encrypted  = base64_encode($ciphertext) . '?iv=' . base64_encode($iv);
        
        test_pass('NIP-04 encryption OK');
        
        // Decrypt as merchant.
        $order_listener = woo_nostr_market()->order_listener;
        $decrypted      = $order_listener->decrypt_nip04($encrypted, $sender_pub);
        
        if (is_wp_error($decrypted)) {
            test_fail('NIP-04 decryption failed: ' . $decrypted->get_error_message());
        } elseif ($decrypted === $plaintext) {
            test_pass('NIP-04 decryption matches plaintext');
        } else {
            test_fail('NIP-04 decryption mismatch');
        }
    }
} catch (Exception $e) {
    test_fail('NIP-04 error: ' . $e->getMessage());
}

// ========================================
echo "\n=== 5. Bech32 Encoding ===\n";
// ========================================

try {
    $client = woo_nostr_market()->nostr_client;
    
    // Test npub encoding.
    $test_hex = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
    $npub     = $client->hex_to_npub($test_hex);
    
    if (is_wp_error($npub)) {
        test_fail('npub encoding failed: ' . $npub->get_error_message());
    } elseif (strpos($npub, 'npub1') === 0) {
        test_pass("npub encoding: $npub");
    } else {
        test_fail("npub encoding wrong format: $npub");
    }
    
    // Test nsec encoding.
    $nsec = $client->hex_to_nsec($test_hex);
    if (is_wp_error($nsec)) {
        test_fail('nsec encoding failed: ' . $nsec->get_error_message());
    } elseif (strpos($nsec, 'nsec1') === 0) {
        test_pass("nsec encoding: nsec1...(redacted)");
    } else {
        test_fail("nsec encoding wrong format");
    }
    
} catch (Exception $e) {
    test_fail('Bech32 error: ' . $e->getMessage());
}

// ========================================
echo "\n=== 6. Webhook Endpoint ===\n";
// ========================================

try {
    $webhook_url    = rest_url('woo-nostr-market/v1/order-webhook');
    $webhook_secret = $settings->get('webhook_secret');
    
    if (empty($webhook_secret)) {
        test_fail('No webhook secret configured — set one in plugin settings');
    } else {
        test_pass("Webhook URL: $webhook_url");
        test_pass('Webhook secret configured');
    }
    
    // Test the test endpoint.
    $test_url  = rest_url('woo-nostr-market/v1/webhook-test');
    $test_resp = wp_remote_post($test_url, [
        'headers' => ['Content-Type' => 'application/json'],
        'body'    => json_encode(['test' => true]),
        'timeout' => 10,
        'sslverify' => false,
    ]);
    
    if (is_wp_error($test_resp)) {
        test_fail('Webhook test endpoint unreachable: ' . $test_resp->get_error_message());
    } else {
        $code = wp_remote_retrieve_response_code($test_resp);
        $body = json_decode(wp_remote_retrieve_body($test_resp), true);
        ($code === 200 && !empty($body['success'])) 
            ? test_pass('Webhook test endpoint responding') 
            : test_fail("Webhook test returned HTTP $code");
    }
    
} catch (Exception $e) {
    test_fail('Webhook error: ' . $e->getMessage());
}

// ========================================
echo "\n=== 7. Full Webhook Simulation ===\n";
// ========================================

try {
    if (empty($merchant_priv) || empty($webhook_secret)) {
        test_fail('Skipping — need merchant keys + webhook secret configured');
    } else {
        // Create a fake sender.
        $fake_sender_priv = bin2hex(random_bytes(32));
        $fake_sender_pub  = $ec->derive_public_key($fake_sender_priv);
        
        // Encrypt a test order.
        $shared_hex = $ec->ecdh($fake_sender_priv, $merchant_pub);
        $shared     = hex2bin($shared_hex);
        $iv         = openssl_random_pseudo_bytes(16);
        $order_json = json_encode([
            'type'    => 0,
            'id'      => 'webhook-test-' . time(),
            'items'   => [['product_id' => '99999', 'quantity' => 1]], // Non-existent product.
            'message' => 'Automated test order — should fail on product lookup.',
        ]);
        $ciphertext = openssl_encrypt($order_json, 'aes-256-cbc', $shared, OPENSSL_RAW_DATA, $iv);
        $encrypted  = base64_encode($ciphertext) . '?iv=' . base64_encode($iv);
        
        // Build webhook payload.
        $payload = json_encode([
            'event' => [
                'id'         => bin2hex(random_bytes(32)),
                'pubkey'     => $fake_sender_pub,
                'kind'       => 4,
                'content'    => $encrypted,
                'sig'        => bin2hex(random_bytes(64)), // Fake sig (we don't verify event sigs).
                'tags'       => [['p', $merchant_pub]],
                'created_at' => time(),
            ],
            'relay'      => 'wss://test.relay',
            'receivedAt' => time(),
        ]);
        
        // Compute HMAC.
        $sig = hash_hmac('sha256', $payload, $webhook_secret);
        
        // Send to webhook.
        $webhook_url = rest_url('woo-nostr-market/v1/order-webhook');
        $resp = wp_remote_post($webhook_url, [
            'headers' => [
                'Content-Type'         => 'application/json',
                'X-Webhook-Signature'  => "sha256=$sig",
            ],
            'body'      => $payload,
            'timeout'   => 15,
            'sslverify' => false,
        ]);
        
        if (is_wp_error($resp)) {
            test_fail('Webhook request failed: ' . $resp->get_error_message());
        } else {
            $code = wp_remote_retrieve_response_code($resp);
            $body = json_decode(wp_remote_retrieve_body($resp), true);
            
            if ($code === 200 && isset($body['error'])) {
                // We expect it to fail on "product not found" — that means decryption WORKED.
                if (in_array($body['error'], ['product_not_found', 'missing_field', 'invalid_item'], true)) {
                    test_pass("Webhook processed correctly — decryption worked, failed on expected error: {$body['error']}");
                } elseif ($body['error'] === 'decryption_failed') {
                    test_fail("Decryption still failing: {$body['message']}");
                } else {
                    // Any other error after decryption succeeded is fine for a test.
                    test_pass("Webhook reached order processing (error: {$body['error']} — {$body['message']})");
                }
            } elseif ($code === 200 && !empty($body['success'])) {
                test_pass('Webhook created a WooCommerce order! (WC #' . ($body['wc_order'] ?? '?') . ')');
            } else {
                test_fail("Webhook returned HTTP $code: " . wp_remote_retrieve_body($resp));
            }
        }
    }
} catch (Exception $e) {
    test_fail('Webhook simulation error: ' . $e->getMessage());
}

// ========================================
echo "\n=== 8. Plugin Settings ===\n";
// ========================================

$relay_urls = $settings->get_relay_urls();
(count($relay_urls) > 0) ? test_pass(count($relay_urls) . ' relays configured') : test_fail('No relays configured');

$enable_nip15 = $settings->get('enable_nip15', true);
$enable_nip99 = $settings->get('enable_nip99', true);
echo "  ℹ️  NIP-15 (Plebeian Market): " . ($enable_nip15 ? 'enabled' : 'disabled') . "\n";
echo "  ℹ️  NIP-99 (Shopstr): " . ($enable_nip99 ? 'enabled' : 'disabled') . "\n";

$btcpay_url = $settings->get('btcpay_url');
$has_btcpay = !empty($btcpay_url) && !empty($settings->get('btcpay_api_key'));
echo "  ℹ️  BTCPay Server: " . ($has_btcpay ? "configured ($btcpay_url)" : 'not configured') . "\n";

$ln_addr = $settings->get('lightning_address');
echo "  ℹ️  Lightning Address: " . ($ln_addr ?: 'not set') . "\n";

$products = wp_count_posts('product');
echo "  ℹ️  Published products: " . ($products->publish ?? 0) . "\n";

// ========================================
echo "\n========================================\n";
echo "Results: $pass passed, $fail failed\n";
echo "========================================\n";

exit($fail > 0 ? 1 : 0);
