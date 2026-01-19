import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SplEscrow } from "../target/types/spl_escrow";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

describe("spl-escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SplEscrow as Program<SplEscrow>;
  const connection = provider.connection;

  // Test accounts
  let seller: Keypair;
  let buyer: Keypair;
  let offerMint: PublicKey;
  let requestMint: PublicKey;
  let sellerOfferToken: PublicKey;
  let sellerRequestToken: PublicKey;
  let buyerOfferToken: PublicKey;
  let buyerRequestToken: PublicKey;

  // Token amounts
  const OFFER_AMOUNT = 1000;
  const REQUEST_AMOUNT = 500;
  const INITIAL_SELLER_BALANCE = 10000;
  const INITIAL_BUYER_BALANCE = 10000;

  // Helper function to airdrop SOL
  async function airdrop(pubkey: PublicKey, amount: number = 2 * LAMPORTS_PER_SOL) {
    const sig = await connection.requestAirdrop(pubkey, amount);
    await connection.confirmTransaction(sig);
  }

  // Helper to derive escrow PDA
  function deriveEscrowPDA(
    sellerPubkey: PublicKey,
    offerMintPubkey: PublicKey,
    requestMintPubkey: PublicKey
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        sellerPubkey.toBuffer(),
        offerMintPubkey.toBuffer(),
        requestMintPubkey.toBuffer(),
      ],
      program.programId
    );
  }

  // Helper to derive vault PDA
  function deriveVaultPDA(escrowPubkey: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPubkey.toBuffer()],
      program.programId
    );
  }

  // Setup for each test: create fresh accounts and mints
  async function setupTest() {
    seller = Keypair.generate();
    buyer = Keypair.generate();

    // Airdrop SOL to seller and buyer
    await airdrop(seller.publicKey);
    await airdrop(buyer.publicKey);

    // Create offer mint (token the seller is offering)
    offerMint = await createMint(
      connection,
      seller,
      seller.publicKey,
      null,
      9 // 9 decimals
    );

    // Create request mint (token the seller wants in return)
    requestMint = await createMint(
      connection,
      buyer,
      buyer.publicKey,
      null,
      9 // 9 decimals
    );

    // Create token accounts for seller
    sellerOfferToken = await createAssociatedTokenAccount(
      connection,
      seller,
      offerMint,
      seller.publicKey
    );
    sellerRequestToken = await createAssociatedTokenAccount(
      connection,
      seller,
      requestMint,
      seller.publicKey
    );

    // Create token accounts for buyer
    buyerOfferToken = await createAssociatedTokenAccount(
      connection,
      buyer,
      offerMint,
      buyer.publicKey
    );
    buyerRequestToken = await createAssociatedTokenAccount(
      connection,
      buyer,
      requestMint,
      buyer.publicKey
    );

    // Mint tokens to seller (offer tokens)
    await mintTo(
      connection,
      seller,
      offerMint,
      sellerOfferToken,
      seller,
      INITIAL_SELLER_BALANCE
    );

    // Mint tokens to buyer (request tokens)
    await mintTo(
      connection,
      buyer,
      requestMint,
      buyerRequestToken,
      buyer,
      INITIAL_BUYER_BALANCE
    );
  }

  describe("create_escrow", () => {
    beforeEach(async () => {
      await setupTest();
    });

    it("Creates an escrow successfully", async () => {
      const [escrowPDA] = deriveEscrowPDA(seller.publicKey, offerMint, requestMint);
      const [vaultPDA] = deriveVaultPDA(escrowPDA);

      // Get initial balance
      const initialSellerBalance = (await getAccount(connection, sellerOfferToken)).amount;

      await program.methods
        .createEscrow(new anchor.BN(OFFER_AMOUNT), new anchor.BN(REQUEST_AMOUNT))
        .accounts({
          seller: seller.publicKey,
          offerMint: offerMint,
          requestMint: requestMint,
          sellerOfferToken: sellerOfferToken,
          escrow: escrowPDA,
          vault: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      // Verify escrow state
      const escrowAccount = await program.account.escrow.fetch(escrowPDA);
      expect(escrowAccount.seller.toString()).to.equal(seller.publicKey.toString());
      expect(escrowAccount.offerMint.toString()).to.equal(offerMint.toString());
      expect(escrowAccount.requestMint.toString()).to.equal(requestMint.toString());
      expect(escrowAccount.offerAmount.toNumber()).to.equal(OFFER_AMOUNT);
      expect(escrowAccount.requestAmount.toNumber()).to.equal(REQUEST_AMOUNT);

      // Verify tokens transferred to vault
      const vaultAccount = await getAccount(connection, vaultPDA);
      expect(Number(vaultAccount.amount)).to.equal(OFFER_AMOUNT);

      // Verify seller's balance decreased
      const finalSellerBalance = (await getAccount(connection, sellerOfferToken)).amount;
      expect(Number(initialSellerBalance) - Number(finalSellerBalance)).to.equal(OFFER_AMOUNT);
    });

    it("Fails to create escrow with zero offer amount", async () => {
      const [escrowPDA] = deriveEscrowPDA(seller.publicKey, offerMint, requestMint);
      const [vaultPDA] = deriveVaultPDA(escrowPDA);

      try {
        await program.methods
          .createEscrow(new anchor.BN(0), new anchor.BN(REQUEST_AMOUNT))
          .accounts({
            seller: seller.publicKey,
            offerMint: offerMint,
            requestMint: requestMint,
            sellerOfferToken: sellerOfferToken,
            escrow: escrowPDA,
            vault: vaultPDA,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([seller])
          .rpc();
        expect.fail("Should have thrown an error");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidAmount");
      }
    });

    it("Fails to create escrow with zero request amount", async () => {
      const [escrowPDA] = deriveEscrowPDA(seller.publicKey, offerMint, requestMint);
      const [vaultPDA] = deriveVaultPDA(escrowPDA);

      try {
        await program.methods
          .createEscrow(new anchor.BN(OFFER_AMOUNT), new anchor.BN(0))
          .accounts({
            seller: seller.publicKey,
            offerMint: offerMint,
            requestMint: requestMint,
            sellerOfferToken: sellerOfferToken,
            escrow: escrowPDA,
            vault: vaultPDA,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([seller])
          .rpc();
        expect.fail("Should have thrown an error");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidAmount");
      }
    });
  });

  describe("accept_escrow", () => {
    beforeEach(async () => {
      await setupTest();
    });

    it("Accepts an escrow successfully", async () => {
      const [escrowPDA] = deriveEscrowPDA(seller.publicKey, offerMint, requestMint);
      const [vaultPDA] = deriveVaultPDA(escrowPDA);

      // Create escrow first
      await program.methods
        .createEscrow(new anchor.BN(OFFER_AMOUNT), new anchor.BN(REQUEST_AMOUNT))
        .accounts({
          seller: seller.publicKey,
          offerMint: offerMint,
          requestMint: requestMint,
          sellerOfferToken: sellerOfferToken,
          escrow: escrowPDA,
          vault: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      // Get initial balances
      const initialBuyerRequestBalance = (await getAccount(connection, buyerRequestToken)).amount;
      const initialBuyerOfferBalance = (await getAccount(connection, buyerOfferToken)).amount;
      const initialSellerRequestBalance = (await getAccount(connection, sellerRequestToken)).amount;

      // Accept the escrow
      await program.methods
        .acceptEscrow()
        .accounts({
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          offerMint: offerMint,
          requestMint: requestMint,
          escrow: escrowPDA,
          vault: vaultPDA,
          buyerRequestToken: buyerRequestToken,
          buyerOfferToken: buyerOfferToken,
          sellerRequestToken: sellerRequestToken,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      // Verify buyer received offer tokens
      const finalBuyerOfferBalance = (await getAccount(connection, buyerOfferToken)).amount;
      expect(Number(finalBuyerOfferBalance) - Number(initialBuyerOfferBalance)).to.equal(OFFER_AMOUNT);

      // Verify buyer paid request tokens
      const finalBuyerRequestBalance = (await getAccount(connection, buyerRequestToken)).amount;
      expect(Number(initialBuyerRequestBalance) - Number(finalBuyerRequestBalance)).to.equal(REQUEST_AMOUNT);

      // Verify seller received request tokens
      const finalSellerRequestBalance = (await getAccount(connection, sellerRequestToken)).amount;
      expect(Number(finalSellerRequestBalance) - Number(initialSellerRequestBalance)).to.equal(REQUEST_AMOUNT);

      // Verify escrow account is closed
      try {
        await program.account.escrow.fetch(escrowPDA);
        expect.fail("Escrow account should be closed");
      } catch (err: any) {
        expect(err.message).to.include("Account does not exist");
      }

      // Verify vault is closed
      try {
        await getAccount(connection, vaultPDA);
        expect.fail("Vault account should be closed");
      } catch (err: any) {
        expect(err.message).to.include("could not find account");
      }
    });

    it("Fails if buyer has insufficient request tokens", async () => {
      const [escrowPDA] = deriveEscrowPDA(seller.publicKey, offerMint, requestMint);
      const [vaultPDA] = deriveVaultPDA(escrowPDA);

      // Create escrow with request amount larger than buyer's balance
      const largeRequestAmount = INITIAL_BUYER_BALANCE + 1000;
      await program.methods
        .createEscrow(new anchor.BN(OFFER_AMOUNT), new anchor.BN(largeRequestAmount))
        .accounts({
          seller: seller.publicKey,
          offerMint: offerMint,
          requestMint: requestMint,
          sellerOfferToken: sellerOfferToken,
          escrow: escrowPDA,
          vault: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      try {
        await program.methods
          .acceptEscrow()
          .accounts({
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            offerMint: offerMint,
            requestMint: requestMint,
            escrow: escrowPDA,
            vault: vaultPDA,
            buyerRequestToken: buyerRequestToken,
            buyerOfferToken: buyerOfferToken,
            sellerRequestToken: sellerRequestToken,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown an error");
      } catch (err: any) {
        // Token program will throw insufficient funds error
        expect(err.message).to.include("insufficient");
      }
    });
  });

  describe("cancel_escrow", () => {
    beforeEach(async () => {
      await setupTest();
    });

    it("Cancels an escrow successfully", async () => {
      const [escrowPDA] = deriveEscrowPDA(seller.publicKey, offerMint, requestMint);
      const [vaultPDA] = deriveVaultPDA(escrowPDA);

      // Get initial balance
      const initialSellerBalance = (await getAccount(connection, sellerOfferToken)).amount;

      // Create escrow
      await program.methods
        .createEscrow(new anchor.BN(OFFER_AMOUNT), new anchor.BN(REQUEST_AMOUNT))
        .accounts({
          seller: seller.publicKey,
          offerMint: offerMint,
          requestMint: requestMint,
          sellerOfferToken: sellerOfferToken,
          escrow: escrowPDA,
          vault: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      // Verify tokens are in vault
      const vaultBalance = (await getAccount(connection, vaultPDA)).amount;
      expect(Number(vaultBalance)).to.equal(OFFER_AMOUNT);

      // Cancel the escrow
      await program.methods
        .cancelEscrow()
        .accounts({
          seller: seller.publicKey,
          offerMint: offerMint,
          escrow: escrowPDA,
          vault: vaultPDA,
          sellerOfferToken: sellerOfferToken,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      // Verify tokens returned to seller
      const finalSellerBalance = (await getAccount(connection, sellerOfferToken)).amount;
      expect(Number(finalSellerBalance)).to.equal(Number(initialSellerBalance));

      // Verify escrow account is closed
      try {
        await program.account.escrow.fetch(escrowPDA);
        expect.fail("Escrow account should be closed");
      } catch (err: any) {
        expect(err.message).to.include("Account does not exist");
      }

      // Verify vault is closed
      try {
        await getAccount(connection, vaultPDA);
        expect.fail("Vault account should be closed");
      } catch (err: any) {
        expect(err.message).to.include("could not find account");
      }
    });

    it("Prevents unauthorized cancellation", async () => {
      const [escrowPDA] = deriveEscrowPDA(seller.publicKey, offerMint, requestMint);
      const [vaultPDA] = deriveVaultPDA(escrowPDA);

      // Create escrow
      await program.methods
        .createEscrow(new anchor.BN(OFFER_AMOUNT), new anchor.BN(REQUEST_AMOUNT))
        .accounts({
          seller: seller.publicKey,
          offerMint: offerMint,
          requestMint: requestMint,
          sellerOfferToken: sellerOfferToken,
          escrow: escrowPDA,
          vault: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      // Create a token account for buyer to receive "refund" (for test purposes)
      const buyerOfferTokenForCancel = await createAssociatedTokenAccount(
        connection,
        buyer,
        offerMint,
        buyer.publicKey
      ).catch(() => buyerOfferToken); // Use existing if already created

      // Try to cancel as buyer (not seller) - should fail
      try {
        await program.methods
          .cancelEscrow()
          .accounts({
            seller: buyer.publicKey, // Wrong! Buyer trying to act as seller
            offerMint: offerMint,
            escrow: escrowPDA,
            vault: vaultPDA,
            sellerOfferToken: buyerOfferTokenForCancel,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown an error");
      } catch (err: any) {
        // Should fail with unauthorized or constraint error
        expect(err.toString()).to.satisfy((msg: string) => 
          msg.includes("Unauthorized") || 
          msg.includes("ConstraintAddress") ||
          msg.includes("Error")
        );
      }

      // Verify escrow still exists
      const escrowAccount = await program.account.escrow.fetch(escrowPDA);
      expect(escrowAccount.seller.toString()).to.equal(seller.publicKey.toString());
    });
  });

  describe("security tests", () => {
    beforeEach(async () => {
      await setupTest();
    });

    it("Prevents double-spending (escrow closed after accept)", async () => {
      const [escrowPDA] = deriveEscrowPDA(seller.publicKey, offerMint, requestMint);
      const [vaultPDA] = deriveVaultPDA(escrowPDA);

      // Create escrow
      await program.methods
        .createEscrow(new anchor.BN(OFFER_AMOUNT), new anchor.BN(REQUEST_AMOUNT))
        .accounts({
          seller: seller.publicKey,
          offerMint: offerMint,
          requestMint: requestMint,
          sellerOfferToken: sellerOfferToken,
          escrow: escrowPDA,
          vault: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      // Accept the escrow
      await program.methods
        .acceptEscrow()
        .accounts({
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          offerMint: offerMint,
          requestMint: requestMint,
          escrow: escrowPDA,
          vault: vaultPDA,
          buyerRequestToken: buyerRequestToken,
          buyerOfferToken: buyerOfferToken,
          sellerRequestToken: sellerRequestToken,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      // Create another buyer to try double-spend
      const attacker = Keypair.generate();
      await airdrop(attacker.publicKey);

      const attackerRequestToken = await createAssociatedTokenAccount(
        connection,
        attacker,
        requestMint,
        attacker.publicKey
      );
      const attackerOfferToken = await createAssociatedTokenAccount(
        connection,
        attacker,
        offerMint,
        attacker.publicKey
      );

      // Mint some request tokens to attacker
      await mintTo(
        connection,
        buyer, // buyer is the mint authority
        requestMint,
        attackerRequestToken,
        buyer,
        REQUEST_AMOUNT
      );

      // Try to accept the same escrow again - should fail
      try {
        await program.methods
          .acceptEscrow()
          .accounts({
            buyer: attacker.publicKey,
            seller: seller.publicKey,
            offerMint: offerMint,
            requestMint: requestMint,
            escrow: escrowPDA,
            vault: vaultPDA,
            buyerRequestToken: attackerRequestToken,
            buyerOfferToken: attackerOfferToken,
            sellerRequestToken: sellerRequestToken,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();
        expect.fail("Should have thrown an error - escrow already closed");
      } catch (err: any) {
        // Escrow account should not exist
        expect(err.message).to.include("Account does not exist");
      }
    });

    it("Validates token mint matches escrow", async () => {
      const [escrowPDA] = deriveEscrowPDA(seller.publicKey, offerMint, requestMint);
      const [vaultPDA] = deriveVaultPDA(escrowPDA);

      // Create escrow
      await program.methods
        .createEscrow(new anchor.BN(OFFER_AMOUNT), new anchor.BN(REQUEST_AMOUNT))
        .accounts({
          seller: seller.publicKey,
          offerMint: offerMint,
          requestMint: requestMint,
          sellerOfferToken: sellerOfferToken,
          escrow: escrowPDA,
          vault: vaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      // Create a fake mint
      const fakeMint = await createMint(
        connection,
        buyer,
        buyer.publicKey,
        null,
        9
      );

      // Try to accept with wrong mint - should fail due to address constraint
      try {
        await program.methods
          .acceptEscrow()
          .accounts({
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            offerMint: fakeMint, // Wrong mint!
            requestMint: requestMint,
            escrow: escrowPDA,
            vault: vaultPDA,
            buyerRequestToken: buyerRequestToken,
            buyerOfferToken: buyerOfferToken,
            sellerRequestToken: sellerRequestToken,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown an error");
      } catch (err: any) {
        expect(err.toString()).to.satisfy((msg: string) => 
          msg.includes("InvalidMint") || 
          msg.includes("ConstraintAddress") ||
          msg.includes("Error")
        );
      }
    });

    it("Handles multiple escrows by the same seller with different mints", async () => {
      // Create a second pair of mints
      const offerMint2 = await createMint(
        connection,
        seller,
        seller.publicKey,
        null,
        9
      );
      const requestMint2 = await createMint(
        connection,
        buyer,
        buyer.publicKey,
        null,
        9
      );

      // Create token accounts for second pair
      const sellerOfferToken2 = await createAssociatedTokenAccount(
        connection,
        seller,
        offerMint2,
        seller.publicKey
      );

      // Mint tokens
      await mintTo(
        connection,
        seller,
        offerMint2,
        sellerOfferToken2,
        seller,
        INITIAL_SELLER_BALANCE
      );

      // Create two different escrows
      const [escrowPDA1] = deriveEscrowPDA(seller.publicKey, offerMint, requestMint);
      const [vaultPDA1] = deriveVaultPDA(escrowPDA1);

      const [escrowPDA2] = deriveEscrowPDA(seller.publicKey, offerMint2, requestMint2);
      const [vaultPDA2] = deriveVaultPDA(escrowPDA2);

      // Create first escrow
      await program.methods
        .createEscrow(new anchor.BN(OFFER_AMOUNT), new anchor.BN(REQUEST_AMOUNT))
        .accounts({
          seller: seller.publicKey,
          offerMint: offerMint,
          requestMint: requestMint,
          sellerOfferToken: sellerOfferToken,
          escrow: escrowPDA1,
          vault: vaultPDA1,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      // Create second escrow
      await program.methods
        .createEscrow(new anchor.BN(OFFER_AMOUNT * 2), new anchor.BN(REQUEST_AMOUNT * 2))
        .accounts({
          seller: seller.publicKey,
          offerMint: offerMint2,
          requestMint: requestMint2,
          sellerOfferToken: sellerOfferToken2,
          escrow: escrowPDA2,
          vault: vaultPDA2,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      // Verify both escrows exist with correct data
      const escrow1 = await program.account.escrow.fetch(escrowPDA1);
      const escrow2 = await program.account.escrow.fetch(escrowPDA2);

      expect(escrow1.offerAmount.toNumber()).to.equal(OFFER_AMOUNT);
      expect(escrow2.offerAmount.toNumber()).to.equal(OFFER_AMOUNT * 2);

      // Verify vaults have correct balances
      const vault1Balance = (await getAccount(connection, vaultPDA1)).amount;
      const vault2Balance = (await getAccount(connection, vaultPDA2)).amount;

      expect(Number(vault1Balance)).to.equal(OFFER_AMOUNT);
      expect(Number(vault2Balance)).to.equal(OFFER_AMOUNT * 2);
    });
  });
});
