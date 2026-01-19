use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{close_account, transfer, CloseAccount, Mint, Token, TokenAccount, Transfer},
};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod spl_escrow {
    use super::*;

    /// Create a new escrow offer
    /// - Lock seller's tokens in escrow vault PDA
    /// - Store escrow details (seller, amounts, mints)
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        offer_amount: u64,
        request_amount: u64,
    ) -> Result<()> {
        require!(offer_amount > 0, EscrowError::InvalidAmount);
        require!(request_amount > 0, EscrowError::InvalidAmount);

        // Initialize escrow state
        let escrow = &mut ctx.accounts.escrow;
        escrow.seller = ctx.accounts.seller.key();
        escrow.offer_mint = ctx.accounts.offer_mint.key();
        escrow.request_mint = ctx.accounts.request_mint.key();
        escrow.offer_amount = offer_amount;
        escrow.request_amount = request_amount;
        escrow.escrow_bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;

        // Transfer tokens from seller to escrow vault
        transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.seller_offer_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            offer_amount,
        )?;

        msg!(
            "Escrow created: {} tokens offered for {} tokens requested",
            offer_amount,
            request_amount
        );

        Ok(())
    }

    /// Accept an escrow offer
    /// - Transfer buyer's tokens to seller
    /// - Transfer escrowed tokens to buyer
    /// - Close escrow accounts
    pub fn accept_escrow(ctx: Context<AcceptEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let offer_amount = escrow.offer_amount;
        let request_amount = escrow.request_amount;

        // Create signer seeds for the escrow PDA
        let seller_key = escrow.seller;
        let offer_mint_key = escrow.offer_mint;
        let request_mint_key = escrow.request_mint;
        let escrow_bump = escrow.escrow_bump;

        let escrow_seeds = &[
            b"escrow",
            seller_key.as_ref(),
            offer_mint_key.as_ref(),
            request_mint_key.as_ref(),
            &[escrow_bump],
        ];
        let signer_seeds = &[&escrow_seeds[..]];

        // Transfer request tokens from buyer to seller
        transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_request_token.to_account_info(),
                    to: ctx.accounts.seller_request_token.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            request_amount,
        )?;

        // Transfer offer tokens from vault to buyer
        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.buyer_offer_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            offer_amount,
        )?;

        // Close the vault token account and return rent to seller
        close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.seller.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer_seeds,
        ))?;

        msg!("Escrow accepted successfully");

        Ok(())
    }

    /// Cancel an escrow offer
    /// - Refund escrowed tokens to seller
    /// - Close escrow accounts
    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let offer_amount = escrow.offer_amount;

        // Create signer seeds for the escrow PDA
        let seller_key = escrow.seller;
        let offer_mint_key = escrow.offer_mint;
        let request_mint_key = escrow.request_mint;
        let escrow_bump = escrow.escrow_bump;

        let escrow_seeds = &[
            b"escrow",
            seller_key.as_ref(),
            offer_mint_key.as_ref(),
            request_mint_key.as_ref(),
            &[escrow_bump],
        ];
        let signer_seeds = &[&escrow_seeds[..]];

        // Transfer tokens back to seller
        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.seller_offer_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            offer_amount,
        )?;

        // Close the vault token account and return rent to seller
        close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.seller.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer_seeds,
        ))?;

        msg!("Escrow cancelled, tokens returned to seller");

        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    pub offer_mint: Box<Account<'info, Mint>>,
    pub request_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = seller_offer_token.mint == offer_mint.key() @ EscrowError::InvalidMint,
        constraint = seller_offer_token.owner == seller.key() @ EscrowError::InvalidTokenAccountOwner,
    )]
    pub seller_offer_token: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = seller,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [
            b"escrow",
            seller.key().as_ref(),
            offer_mint.key().as_ref(),
            request_mint.key().as_ref(),
        ],
        bump,
    )]
    pub escrow: Box<Account<'info, Escrow>>,

    #[account(
        init,
        payer = seller,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = offer_mint,
        token::authority = escrow,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptEscrow<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: Validated via escrow.seller constraint
    #[account(mut, address = escrow.seller @ EscrowError::Unauthorized)]
    pub seller: AccountInfo<'info>,

    #[account(address = escrow.offer_mint @ EscrowError::InvalidMint)]
    pub offer_mint: Box<Account<'info, Mint>>,

    #[account(address = escrow.request_mint @ EscrowError::InvalidMint)]
    pub request_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [
            b"escrow",
            escrow.seller.as_ref(),
            escrow.offer_mint.as_ref(),
            escrow.request_mint.as_ref(),
        ],
        bump = escrow.escrow_bump,
        close = seller,
    )]
    pub escrow: Box<Account<'info, Escrow>>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = buyer_request_token.mint == request_mint.key() @ EscrowError::InvalidMint,
        constraint = buyer_request_token.owner == buyer.key() @ EscrowError::InvalidTokenAccountOwner,
    )]
    pub buyer_request_token: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = buyer_offer_token.mint == offer_mint.key() @ EscrowError::InvalidMint,
        constraint = buyer_offer_token.owner == buyer.key() @ EscrowError::InvalidTokenAccountOwner,
    )]
    pub buyer_offer_token: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = seller_request_token.mint == request_mint.key() @ EscrowError::InvalidMint,
        constraint = seller_request_token.owner == escrow.seller @ EscrowError::InvalidTokenAccountOwner,
    )]
    pub seller_request_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    #[account(
        mut,
        address = escrow.seller @ EscrowError::Unauthorized,
    )]
    pub seller: Signer<'info>,

    #[account(address = escrow.offer_mint @ EscrowError::InvalidMint)]
    pub offer_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [
            b"escrow",
            escrow.seller.as_ref(),
            escrow.offer_mint.as_ref(),
            escrow.request_mint.as_ref(),
        ],
        bump = escrow.escrow_bump,
        close = seller,
    )]
    pub escrow: Box<Account<'info, Escrow>>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = seller_offer_token.mint == offer_mint.key() @ EscrowError::InvalidMint,
        constraint = seller_offer_token.owner == seller.key() @ EscrowError::InvalidTokenAccountOwner,
    )]
    pub seller_offer_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub seller: Pubkey,
    pub offer_mint: Pubkey,
    pub request_mint: Pubkey,
    pub offer_amount: u64,
    pub request_amount: u64,
    pub escrow_bump: u8,
    pub vault_bump: u8,
}

#[error_code]
pub enum EscrowError {
    #[msg("Unauthorized: Only the seller can perform this action")]
    Unauthorized,
    #[msg("Invalid token mint")]
    InvalidMint,
    #[msg("Invalid token account owner")]
    InvalidTokenAccountOwner,
    #[msg("Invalid amount: must be greater than zero")]
    InvalidAmount,
}
